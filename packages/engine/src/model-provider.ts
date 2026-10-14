// Local model transport seam (ADR-0002): Ollama today, BYOK cloud adapters later.
// HTTP only — no Electron/DOM. Callers use getModelProvider() or inject via setModelProvider() in tests.


// ---- Ollama HTTP budgets ----------------------------------------------------
// Node/Electron `fetch` is undici. Undici defaults `headersTimeout`/`bodyTimeout` to
// 300_000 ms (5 min). Non-streaming `/api/chat` (tool-required `chatWithTools`,
// and one-shot `chat`) does not send response headers until generation finishes,
// so a slow local model under load
// hits HeadersTimeoutError and surfaces as opaque "fetch failed" → "Local Ollama
// request failed". Streaming classic Ask resets body timeouts on each token, so it
// survives the same load. Raise the undici ceilings and pair them with AbortSignal
// so agentic Ask can finish OR fail with an explicit timeout message.

/** Per-request budget for listModels / tags. */
export const OLLAMA_TAGS_TIMEOUT_MS = 30_000;
/** Per-request budget for embeddings. */
export const OLLAMA_EMBED_TIMEOUT_MS = 120_000;
/** Per-request budget for non-streaming chat (classic one-shot `ask`). */
export const OLLAMA_CHAT_TIMEOUT_MS = 600_000;
/** Per-request budget for streaming chat (classic `chat:send`). */
export const OLLAMA_CHAT_STREAM_TIMEOUT_MS = 600_000;
/**
 * Per-request budget for one non-streaming tool-calling turn (`chatWithTools`).
 * Must exceed undici's 300s default — agentic Ask and Agent mode use this path.
 */
export const OLLAMA_CHAT_TOOLS_TIMEOUT_MS = 600_000;
/** Background chat-model preload. Long enough for a cold 8B load, short of the ask budget. */
export const OLLAMA_WARM_TIMEOUT_MS = 180_000;
/** How long a warmed chat model stays resident. Ollama's default idle unload is 5m. */
export const CHAT_MODEL_KEEP_ALIVE = "30m";

export type ChatWarmResult = "warmed" | "skipped" | "failed";

/** Which Ask prefix a warm should leave in the prompt cache. */
export type ChatWarmKind = "agentic" | "classic";

/**
 * The stable prefix of the next Ask. `tools` is set for agentic so the warm
 * hits `/v1/chat/completions` with the same tool definitions as the first turn.
 */
export interface ChatWarmRequest {
  kind: ChatWarmKind;
  messages: ChatMessage[];
  tools?: ToolSchema[];
}

/** Result of one background Ollama check used to decide whether to warm again. */
export interface OllamaWarmProbe {
  up: boolean;
  models: string[];
  /** Down→up, a new server instance, or `/api/ps` lost the primed model. */
  recovered: boolean;
}

const ollamaAgentByTimeout = new Map<number, object>();
let undiciFetch: typeof fetch | null = null;

async function ollamaDispatcher(timeoutMs: number): Promise<object | undefined> {
  const cached = ollamaAgentByTimeout.get(timeoutMs);
  if (cached) return cached;
  try {
    // undici ships with Node; keep the import dynamic so the engine stays runnable
    // even if a bundler cannot statically resolve the package.
    const undici = (await import("undici")) as {
      Agent: new (opts: {
        headersTimeout?: number;
        bodyTimeout?: number;
        connect?: { timeout?: number };
      }) => object;
    };
    const agent = new undici.Agent({
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      connect: { timeout: 30_000 },
    });
    ollamaAgentByTimeout.set(timeoutMs, agent);
    return agent;
  } catch {
    return undefined;
  }
}

/** Node/Electron main should use undici `fetch` so `dispatcher` + `AbortSignal.timeout` apply. */
async function ollamaFetchImpl(): Promise<typeof fetch> {
  if (undiciFetch) return undiciFetch;
  try {
    const undici = (await import("undici")) as { fetch: typeof fetch };
    const inElectron = typeof process !== "undefined" && Boolean(process.versions?.electron);
    // node --test patches globalThis.fetch; honor that outside Electron.
    if (!inElectron && globalThis.fetch !== undici.fetch) {
      undiciFetch = globalThis.fetch;
    } else {
      undiciFetch = undici.fetch;
    }
    return undiciFetch;
  } catch {
    undiciFetch = fetch;
    return undiciFetch;
  }
}

function isTimeoutError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    const name = typeof e.name === "string" ? e.name : "";
    const code = typeof e.code === "string" ? e.code : "";
    const message = typeof e.message === "string" ? e.message : "";
    if (
      name === "HeadersTimeoutError" ||
      name === "BodyTimeoutError" ||
      name === "AbortError" ||
      name === "TimeoutError" ||
      code === "UND_ERR_HEADERS_TIMEOUT" ||
      code === "UND_ERR_BODY_TIMEOUT" ||
      code === "ABORT_ERR" ||
      /headers timeout|body timeout|aborted due to timeout|The operation was aborted/i.test(message)
    ) {
      return true;
    }
    cur = e.cause;
  }
  return false;
}

/** Thrown when an Ollama HTTP call exceeds its budget (allow-listed by desktop user-error). */
export class OllamaTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly label: string;
  constructor(label: string, timeoutMs: number, cause?: unknown) {
    const secs = Math.round(timeoutMs / 1000);
    super(
      `Local Ollama request timed out after ${secs}s (${label}). The model may be too slow under load for this path — retry when the machine is quieter, use a faster model, or turn off agentic Ask.`,
    );
    this.name = "OllamaTimeoutError";
    this.timeoutMs = timeoutMs;
    this.label = label;
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

function abortError(): Error {
  return new DOMException("The operation was aborted.", "AbortError");
}

async function ollamaFetch(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  label: string,
  userSignal?: AbortSignal,
): Promise<Response> {
  if (userSignal?.aborted) throw abortError();
  const dispatcher = await ollamaDispatcher(timeoutMs);
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = userSignal ? AbortSignal.any([timeout, userSignal]) : timeout;
  const opts: Record<string, unknown> = { ...(init ?? {}), signal };
  if (dispatcher !== undefined) opts.dispatcher = dispatcher;
  const fetchFn = await ollamaFetchImpl();
  try {
    return await fetchFn(url, opts as RequestInit);
  } catch (err) {
    if (userSignal?.aborted) throw err;
    if (isTimeoutError(err)) throw new OllamaTimeoutError(label, timeoutMs, err);
    throw err;
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ---- Agent tool-calling seam (ADR-0008 write-safety core) --------------------
// The always-on model proposes mutations by calling tools; the engine's bounded
// loop (agent-run.ts) drives it and NEVER writes. Tool-calling is optional on the
// provider so existing adapters keep compiling; callers must feature-detect it.

/** A tool the agent may call, described with a JSON-Schema parameter object. */
export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the arguments object (passed through to Ollama verbatim). */
  parameters: Record<string, unknown>;
}

/** One tool call the model emitted. `arguments` is RAW model output — validate before use. */
export interface ToolCall {
  /** OpenAI-compat `tool_call_id` — required when replaying multi-turn tool history. */
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Per-turn overrides for `chatWithTools` (timeouts, budgets). */
export interface ChatWithToolsOptions {
  /** Overrides `OLLAMA_CHAT_TOOLS_TIMEOUT_MS` for this turn (e.g. remaining wall-clock budget). */
  timeoutMs?: number;
  /**
   * When true, ask Ollama OpenAI-compat to require a tool call this turn (`tool_choice: "required"`).
   * Use on the first agentic Ask turn so Qwen3 cannot emit a long thinking-only reply with no tools.
   * A required tool call stays non-streaming.
   */
  requireToolCall?: boolean;
  /**
   * When set, this turn streams from `/v1/chat/completions` using the same
   * request shape as a non-streaming tool turn. A required tool call stays
   * non-streaming. Malformed streamed tool-call JSON falls back to that
   * non-streaming call (#15497).
   */
  onToken?: (token: string) => void;
  /** Cancels the HTTP call. A timeout abort is separate and still raises `OllamaTimeoutError`. */
  signal?: AbortSignal;
}

/**
 * One message in a tool-loop conversation. Superset of ChatMessage with the two
 * roles the loop needs: an `assistant` turn may carry `toolCalls`, and a `tool`
 * turn carries a result tagged with the `toolName` it answers.
 */
export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolName?: string;
  /** Matches the assistant `tool_calls[].id` this tool result answers (OpenAI-compat history). */
  toolCallId?: string;
}

/** Result of one tool-enabled model turn: prose plus any tool calls it wants run. */
export interface ToolTurn {
  content: string;
  toolCalls: ToolCall[];
}

/**
 * Streaming hooks for token-by-token chat output. `onToken` fires once per delta
 * as the model produces it; the returned Promise still resolves to the full text.
 * The callback shape is deliberately a plain function so an Electron IPC bridge can
 * forward each token over a channel (`onToken: (t) => webContents.send(chan, t)`)
 * without the engine knowing anything about IPC — the seam stays HTTP/DOM-free.
 */
export interface ChatStreamCallbacks {
  onToken?: (token: string) => void;
  /**
   * Fires at most once when a provider reports usage/cost for the turn (cloud
   * adapters do; the local Ollama adapter does not). The ADR-0002 cost-surfacing
   * invariant is satisfied by forwarding this to the UI after an escalated turn.
   */
  onUsage?: (usage: ChatUsage) => void;
  /** Cancels the HTTP call. A timeout abort is separate and still raises `OllamaTimeoutError`. */
  signal?: AbortSignal;
}

/**
 * Token accounting for one chat turn. All fields optional because providers vary:
 * OpenAI-compatible endpoints return prompt/completion tokens; OpenRouter also
 * returns `costUsd`; Ollama returns none. NEVER fabricate — omit what the API
 * did not return (ADR-0002: surface real cost, never an invented estimate).
 */
export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Real charge in USD, only when the API returns it (e.g. OpenRouter). */
  costUsd?: number;
}

export interface ModelProvider {
  listModels(): Promise<string[]>;
  isReachable(): Promise<boolean>;
  embed(model: string, input: string[]): Promise<number[][]>;
  chat(model: string, messages: ChatMessage[], think?: boolean): Promise<string>;
  /**
   * Optional streaming variant. Providers that implement it emit tokens via
   * `callbacks.onToken` and resolve to the accumulated text. Optional so existing
   * adapters keep compiling; callers should fall back to `chat()` when absent.
   */
  chatStream?(
    model: string,
    messages: ChatMessage[],
    callbacks?: ChatStreamCallbacks,
    think?: boolean,
  ): Promise<string>;
  /**
   * Optional tool-calling turn for the agent write-loop (ADR-0008). A required
   * tool call stays non-streaming. When `onToken` is set and a tool call is not
   * required, answer text streams from the same `/v1/chat/completions` request
   * the tool turns use, so the prompt cache stays warm. Malformed streamed
   * tool-call JSON falls back to the non-streaming call (#15497). Providers
   * that cannot call tools omit this.
   */
  chatWithTools?(
    model: string,
    messages: AgentMessage[],
    tools: ToolSchema[],
    options?: ChatWithToolsOptions,
  ): Promise<ToolTurn>;
  /**
   * Prime one chat model's prompt cache and hold it. Embedders are refused.
   * A model this process already primed, that `/api/ps` still lists, is skipped.
   * A different chat model is unloaded (`keep_alive: 0`) first. Failures resolve
   * as `"failed"` and are not remembered, so a later call can retry.
   */
  warmChatModel?(model: string, request: ChatWarmRequest): Promise<ChatWarmResult>;
  /** Drop the primed prompt so the next warm sends it again. */
  forgetWarmedChatModels?(): void;
  /**
   * Reachability plus whether the primed prompt must be sent again. Recovered
   * on the down→up edge, when the server instance changes, or when `/api/ps`
   * drops the model this process primed.
   */
  probeForWarm?(): Promise<OllamaWarmProbe>;
}

/**
 * Down→up edge for a background warm. A check that stays up is not a recovery.
 * A down check clears the remembered up state so the next up check warms again.
 */
export function nextOllamaWarmGate(wasUp: boolean, up: boolean): { wasUp: boolean; recovered: boolean } {
  if (!up) return { wasUp: false, recovered: false };
  return { wasUp: true, recovered: !wasUp };
}

function parseToolCallArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

type OpenAiToolDelta = {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
};

type OpenAiToolAcc = { id?: string; name: string; arguments: string };

/** OpenAI streams one tool call as an id/name chunk plus later argument fragments. */
function mergeOpenAiToolDelta(acc: Map<number, OpenAiToolAcc>, call: OpenAiToolDelta): void {
  const index = typeof call.index === "number" ? call.index : acc.size;
  const cur = acc.get(index) ?? { name: "", arguments: "" };
  if (typeof call.id === "string" && call.id) cur.id = call.id;
  const name = call.function?.name;
  if (typeof name === "string" && name) {
    if (!cur.name || name.startsWith(cur.name)) cur.name = name;
    else if (!cur.name.endsWith(name)) cur.name += name;
  }
  if (typeof call.function?.arguments === "string") cur.arguments += call.function.arguments;
  acc.set(index, cur);
}

/** #15497 can split tool-call JSON into something that is not an object. */
function toolArgumentsMalformed(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed === null || typeof parsed !== "object" || Array.isArray(parsed);
  } catch {
    return true;
  }
}

function normalizeOllamaToolCalls(
  rawCalls: { id?: string; type?: string; function?: { name?: string; arguments?: unknown } }[],
): ToolCall[] {
  const toolCalls: ToolCall[] = [];
  for (let i = 0; i < rawCalls.length; i++) {
    const rc = rawCalls[i];
    const name = rc.function?.name;
    if (typeof name !== "string" || name === "") continue;
    toolCalls.push({
      id: typeof rc.id === "string" && rc.id ? rc.id : `call_${i}`,
      name,
      arguments: parseToolCallArguments(rc.function?.arguments),
    });
  }
  return toolCalls;
}

/** Native `/api/chat` history, including tool calls and tool results. */
function nativeAgentMessages(messages: AgentMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls.map((c, i) => ({
          type: "function",
          function: {
            index: i,
            name: c.name,
            arguments: c.arguments,
          },
        })),
      };
    }
    if (m.role === "tool") {
      return { role: "tool", content: m.content, tool_name: m.toolName };
    }
    return { role: m.role, content: m.content };
  });
}

/** Map Cairn agent history to OpenAI-compat messages (Ollama `/v1/chat/completions`). */
export function agentMessagesToOpenAI(messages: AgentMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: m.toolCallId ?? m.toolName ?? "call_0",
        content: m.content,
      });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      out.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((c, i) => ({
          id: c.id ?? `call_${i}`,
          type: "function",
          function: {
            name: c.name,
            arguments: JSON.stringify(c.arguments ?? {}),
          },
        })),
      });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

function isEmbedModelName(model: string): boolean {
  return /embed/i.test(model);
}

/** `qwen3:8b` and `qwen3:8b:latest` are the same resident model. */
function chatModelKey(model: string): string {
  return model.trim().replace(/:latest$/, "");
}

function ollamaToolDefs(tools: ToolSchema[]): Record<string, unknown>[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/**
 * Identity of one Ollama process. A start/uptime field changes across a
 * restart of the same build; `/api/version` alone does not. Empty when the
 * check could not read one.
 */
export function ollamaInstanceToken(info: { version?: string; startedAt?: string }): string {
  const started = info.startedAt?.trim() ?? "";
  if (started) return `start:${started}`;
  const version = info.version?.trim() ?? "";
  if (version) return `version:${version}`;
  return "";
}

/**
 * True when the primed prompt is gone. A first token (previous empty) is not
 * a change. `/api/ps` unknown (`running === null`) is not a loss. A held model
 * counts as lost only after a check has seen it resident.
 */
export function ollamaWarmInvalidated(
  prev: { token: string; held: string | null; sawHeld: boolean },
  next: { token: string; running: readonly string[] | null },
): boolean {
  if (prev.token !== "" && next.token !== "" && prev.token !== next.token) return true;
  if (!prev.sawHeld || !prev.held || next.running === null) return false;
  const key = chatModelKey(prev.held);
  return !next.running.some((name) => chatModelKey(name) === key);
}

function versionName(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const version = (body as { version?: unknown }).version;
  return typeof version === "string" ? version.trim() : "";
}

function versionStartedAt(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const rec = body as Record<string, unknown>;
  for (const key of ["started_at", "started", "uptime", "start_time"]) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

export class OllamaClient implements ModelProvider {
  /** Chat model whose prompt this process has primed. One model at a time. */
  private heldKey: string | null = null;
  private primedKind: ChatWarmKind | null = null;
  /** True after a prime, so a later `/api/ps` miss is a restart rather than a race. */
  private lastProbeSawHeld = false;
  private wasUp = false;
  private instanceToken = "";
  /** Serializes primes so a mode switch cannot load a second model mid-warm. */
  private warmChain: Promise<void> = Promise.resolve();

  constructor(private readonly baseUrl = process.env.OLLAMA_HOST || "http://localhost:11434") {}

  async warmChatModel(model: string, request: ChatWarmRequest): Promise<ChatWarmResult> {
    const name = model.trim();
    if (!name || isEmbedModelName(name)) return "skipped";
    const run = this.warmChain.then(() => this.primeChatModel(name, request));
    this.warmChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Ollama restarted or dropped the model: the primed prompt is gone. */
  forgetWarmedChatModels(): void {
    this.heldKey = null;
    this.primedKind = null;
    this.lastProbeSawHeld = false;
  }

  async probeForWarm(): Promise<OllamaWarmProbe> {
    // Snapshot before the awaits. A warm that finishes mid-check must not be
    // forgotten because this check's `/api/ps` still shows the old process.
    const prevToken = this.instanceToken;
    const prevHeld = this.heldKey;
    const prevKind = this.primedKind;
    const prevSawHeld = this.lastProbeSawHeld;
    const versionBody = await this.readOllamaVersion();
    let models: string[];
    try {
      models = await this.listModels();
    } catch {
      this.wasUp = false;
      return { up: false, models: [], recovered: false };
    }
    let running: string[] | null;
    try {
      running = await this.runningModelNames();
    } catch {
      running = null;
    }
    const token = ollamaInstanceToken({
      version: versionName(versionBody),
      startedAt: versionStartedAt(versionBody),
    });
    const invalidated = ollamaWarmInvalidated(
      { token: prevToken, held: prevHeld, sawHeld: prevSawHeld },
      { token, running },
    );
    if (token) this.instanceToken = token;
    const gate = nextOllamaWarmGate(this.wasUp, true);
    this.wasUp = gate.wasUp;
    const recovered = gate.recovered || invalidated;
    const stillSamePrime = this.heldKey === prevHeld && this.primedKind === prevKind;
    if (recovered && stillSamePrime) {
      this.forgetWarmedChatModels();
    } else if (!recovered && running && stillSamePrime && this.heldKey) {
      this.lastProbeSawHeld = running.some((name) => chatModelKey(name) === this.heldKey);
    }
    return { up: true, models, recovered };
  }

  private async primeChatModel(model: string, request: ChatWarmRequest): Promise<ChatWarmResult> {
    const key = chatModelKey(model);
    try {
      let running: string[] = [];
      try {
        running = await this.runningModelNames();
      } catch {
        running = [];
      }
      const resident = running.some((listed) => chatModelKey(listed) === key);
      // Skip only when this process already primed this prefix and the weights
      // are still resident. A resident model with a cold prompt still gets primed.
      if (this.heldKey === key && this.primedKind === request.kind && resident) {
        this.lastProbeSawHeld = true;
        return "skipped";
      }
      if (this.heldKey && this.heldKey !== key) {
        await this.releaseChatModel(this.heldKey);
        this.heldKey = null;
        this.primedKind = null;
        this.lastProbeSawHeld = false;
      }
      const primed =
        request.kind === "agentic"
          ? await this.primeAgentic(model, request)
          : await this.primeClassic(model, request);
      if (!primed) return "failed";
      this.heldKey = key;
      this.primedKind = request.kind;
      this.lastProbeSawHeld = true;
      return "warmed";
    } catch {
      return "failed";
    }
  }

  /** Unload the previous chat model so two of them are not resident. */
  private async releaseChatModel(model: string): Promise<void> {
    try {
      const r = await ollamaFetch(
        `${this.baseUrl}/api/chat`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [],
            keep_alive: 0,
            stream: false,
          }),
        },
        OLLAMA_WARM_TIMEOUT_MS,
        "warm-release",
      );
      await r.text().catch(() => "");
    } catch {
      // A failed unload must not block priming the model the next Ask uses.
    }
  }

  private async primeAgentic(model: string, request: ChatWarmRequest): Promise<boolean> {
    const tools = ollamaToolDefs(request.tools ?? []);
    // Same body as the first agentic turn (`tool_choice: required`, thinking off)
    // plus a one-token cap so the prefill lands in the cache and stops.
    const openAiBody: Record<string, unknown> = {
      model,
      stream: false,
      temperature: 0,
      messages: request.messages,
      tools,
      reasoning_effort: "none",
      think: false,
      tool_choice: "required",
      max_tokens: 1,
      keep_alive: CHAT_MODEL_KEEP_ALIVE,
    };
    const openAi = await ollamaFetch(
      `${this.baseUrl}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(openAiBody),
      },
      OLLAMA_WARM_TIMEOUT_MS,
      "warm-chat",
    );
    if (openAi.ok) {
      await openAi.text().catch(() => "");
      return true;
    }
    if (openAi.status !== 404) {
      await openAi.text().catch(() => "");
      return false;
    }
    await openAi.text().catch(() => "");
    return this.postNativePrime(model, request.messages, tools);
  }

  private async primeClassic(model: string, request: ChatWarmRequest): Promise<boolean> {
    return this.postNativePrime(model, request.messages);
  }

  private async postNativePrime(
    model: string,
    messages: ChatMessage[],
    tools?: Record<string, unknown>[],
  ): Promise<boolean> {
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
      think: false,
      keep_alive: CHAT_MODEL_KEEP_ALIVE,
      options: { num_predict: 1 },
    };
    if (tools) body.tools = tools;
    const r = await ollamaFetch(
      `${this.baseUrl}/api/chat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      OLLAMA_WARM_TIMEOUT_MS,
      "warm-chat",
    );
    if (!r.ok) {
      await r.text().catch(() => "");
      return false;
    }
    await r.text().catch(() => "");
    return true;
  }

  private async readOllamaVersion(): Promise<unknown> {
    try {
      const r = await ollamaFetch(
        `${this.baseUrl}/api/version`,
        undefined,
        OLLAMA_TAGS_TIMEOUT_MS,
        "version",
      );
      if (!r.ok) {
        await r.text().catch(() => "");
        return null;
      }
      return await r.json();
    } catch {
      return null;
    }
  }

  private async runningModelNames(): Promise<string[]> {
    const r = await ollamaFetch(`${this.baseUrl}/api/ps`, undefined, OLLAMA_TAGS_TIMEOUT_MS, "ps");
    if (!r.ok) throw new Error(`HTTP ${r.status} from /api/ps`);
    const j = (await r.json()) as { models?: { name?: string; model?: string }[] };
    const names: string[] = [];
    for (const entry of j.models ?? []) {
      if (typeof entry.name === "string" && entry.name) names.push(entry.name);
      if (typeof entry.model === "string" && entry.model) names.push(entry.model);
    }
    return names;
  }

  async listModels(): Promise<string[]> {
    const r = await ollamaFetch(`${this.baseUrl}/api/tags`, undefined, OLLAMA_TAGS_TIMEOUT_MS, "tags");
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${this.baseUrl}/api/tags`);
    const j = (await r.json()) as { models?: { name: string }[] };
    return (j.models ?? []).map((m) => m.name);
  }

  async isReachable(): Promise<boolean> {
    try {
      await this.listModels();
      return true;
    } catch {
      return false;
    }
  }

  async embed(model: string, input: string[]): Promise<number[][]> {
    const r = await ollamaFetch(
      `${this.baseUrl}/api/embed`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input }),
      },
      OLLAMA_EMBED_TIMEOUT_MS,
      "embed",
    );
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status} from /api/embed: ${body.slice(0, 200)}`);
    }
    const j = (await r.json()) as { embeddings?: number[][] };
    if (!j.embeddings || j.embeddings.length === 0) throw new Error("no embeddings in response");
    return j.embeddings;
  }

  async chat(model: string, messages: ChatMessage[], think = false): Promise<string> {
    const body: Record<string, unknown> = { model, messages, stream: false };
    if (think === false) body.think = false;

    const post = () =>
      ollamaFetch(
        `${this.baseUrl}/api/chat`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        OLLAMA_CHAT_TIMEOUT_MS,
        "chat",
      );

    let r = await post();
    if (!r.ok && body.think !== undefined) {
      delete body.think;
      r = await post();
    }
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status} from /api/chat: ${t.slice(0, 200)}`);
    }
    const j = (await r.json()) as { message?: { content?: string } };
    return j.message?.content ?? "";
  }

  async chatStream(
    model: string,
    messages: ChatMessage[],
    callbacks?: ChatStreamCallbacks,
    think = false,
  ): Promise<string> {
    const body: Record<string, unknown> = { model, messages, stream: true };
    if (think === false) body.think = false;
    const signal = callbacks?.signal;

    const post = () =>
      ollamaFetch(
        `${this.baseUrl}/api/chat`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        OLLAMA_CHAT_STREAM_TIMEOUT_MS,
        "chat-stream",
        signal,
      );

    let r = await post();
    if (!r.ok && body.think !== undefined) {
      delete body.think;
      r = await post();
    }
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status} from /api/chat (stream): ${t.slice(0, 200)}`);
    }

    const emit = (line: string, acc: { full: string }) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let obj: { message?: { content?: string }; done?: boolean };
      try {
        obj = JSON.parse(trimmed);
      } catch {
        return;
      }
      const tok = obj.message?.content;
      if (tok) {
        acc.full += tok;
        callbacks?.onToken?.(tok);
      }
    };

    // Ollama streams newline-delimited JSON objects. If the runtime gave us no
    // readable body, fall back to a single non-streamed parse.
    if (!r.body) {
      const j = (await r.json()) as { message?: { content?: string } };
      const c = j.message?.content ?? "";
      if (c) callbacks?.onToken?.(c);
      return c;
    }

    const acc = { full: "" };
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        if (signal?.aborted) throw abortError();
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          emit(buf.slice(0, nl), acc);
          buf = buf.slice(nl + 1);
        }
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      if (isTimeoutError(err)) throw new OllamaTimeoutError("chat-stream", OLLAMA_CHAT_STREAM_TIMEOUT_MS, err);
      throw err;
    }
    if (signal?.aborted) throw abortError();
    emit(buf, acc);
    return acc.full;
  }

  async chatWithTools(
    model: string,
    messages: AgentMessage[],
    tools: ToolSchema[],
    options?: ChatWithToolsOptions,
  ): Promise<ToolTurn> {
    // Answer turns stream on the same `/v1/chat/completions` body as tool turns.
    // A required tool call stays non-streaming.
    if (options?.onToken && !options.requireToolCall) {
      return this.chatWithToolsStream(model, messages, tools, options);
    }
    const timeoutMs = options?.timeoutMs ?? OLLAMA_CHAT_TOOLS_TIMEOUT_MS;
    const ollamaTools = ollamaToolDefs(tools);

    const openAiBody: Record<string, unknown> = {
      model,
      stream: false,
      temperature: 0,
      messages: agentMessagesToOpenAI(messages),
      tools: ollamaTools,
      // Qwen3 + tools + thinking ON can burn max tokens with empty tool_calls (ollama #10976).
      reasoning_effort: "none",
      think: false,
    };
    if (options?.requireToolCall) {
      openAiBody.tool_choice = "required";
    }

    const openAi = await ollamaFetch(
      `${this.baseUrl}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(openAiBody),
      },
      timeoutMs,
      "chat-with-tools",
      options?.signal,
    );
    if (openAi.ok) {
      const j = (await openAi.json()) as {
        choices?: {
          message?: {
            content?: string | null;
            tool_calls?: { id?: string; type?: string; function?: { name?: string; arguments?: unknown } }[];
          };
        }[];
      };
      const msg = j.choices?.[0]?.message;
      const toolCalls = normalizeOllamaToolCalls(msg?.tool_calls ?? []);
      return { content: msg?.content ?? "", toolCalls };
    }

    // Older Ollama builds without OpenAI-compat — fall back to native `/api/chat`.
    if (openAi.status !== 404) {
      const t = await openAi.text().catch(() => "");
      throw new Error(`HTTP ${openAi.status} from /v1/chat/completions (tools): ${t.slice(0, 200)}`);
    }

    const nativeBody: Record<string, unknown> = {
      model,
      stream: false,
      think: false,
      tools: ollamaTools,
      messages: nativeAgentMessages(messages),
    };

    const postNative = async (body: Record<string, unknown>) =>
      ollamaFetch(
        `${this.baseUrl}/api/chat`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        timeoutMs,
        "chat-with-tools",
        options?.signal,
      );

    let r = await postNative(nativeBody);
    if (!r.ok && nativeBody.think !== undefined) {
      delete nativeBody.think;
      r = await postNative(nativeBody);
    }
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status} from /api/chat (tools): ${t.slice(0, 200)}`);
    }
    const j = (await r.json()) as {
      message?: {
        content?: string;
        tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[];
      };
    };
    const toolCalls = normalizeOllamaToolCalls(j.message?.tool_calls ?? []);
    return { content: j.message?.content ?? "", toolCalls };
  }

  /**
   * Stream one tool-capable turn on `/v1/chat/completions`. The body matches
   * the non-streaming tool turn (`reasoning_effort: "none"`, `think: false`,
   * `temperature: 0`, OpenAI messages) so Ollama can reuse that prompt cache.
   * Content deltas are forwarded until a tool call appears. An empty stream,
   * or tool-call JSON that does not parse (#15497), retries once on the
   * non-streaming path.
   */
  private async chatWithToolsStream(
    model: string,
    messages: AgentMessage[],
    tools: ToolSchema[],
    options: ChatWithToolsOptions,
  ): Promise<ToolTurn> {
    const timeoutMs = options.timeoutMs ?? OLLAMA_CHAT_TOOLS_TIMEOUT_MS;
    const startedAt = Date.now();
    // The empty-stream retry shares this turn's deadline. `runAskAgent` passes
    // the remaining wall budget as `timeoutMs`, so a fresh full budget would
    // let one turn run past the 480s wall.
    const retryNonStreaming = (): Promise<ToolTurn> => {
      const remaining = timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) throw new OllamaTimeoutError("chat-with-tools-stream", timeoutMs);
      return this.chatWithTools(model, messages, tools, {
        ...options,
        onToken: undefined,
        timeoutMs: remaining,
      });
    };
    const ollamaTools = ollamaToolDefs(tools);
    const body: Record<string, unknown> = {
      model,
      stream: true,
      temperature: 0,
      messages: agentMessagesToOpenAI(messages),
      tools: ollamaTools,
      reasoning_effort: "none",
      think: false,
    };
    const r = await ollamaFetch(
      `${this.baseUrl}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      timeoutMs,
      "chat-with-tools-stream",
      options.signal,
    );
    if (!r.ok) {
      if (options.signal?.aborted) throw abortError();
      return retryNonStreaming();
    }

    let content = "";
    const toolAcc = new Map<number, OpenAiToolAcc>();
    let sawTool = false;
    const take = (raw: string): void => {
      const trimmed = raw.trim();
      if (!trimmed.startsWith("data:")) return;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") return;
      let obj: {
        choices?: {
          delta?: { content?: string | null; tool_calls?: OpenAiToolDelta[] };
          message?: { content?: string | null; tool_calls?: OpenAiToolDelta[] };
        }[];
      };
      try {
        obj = JSON.parse(data);
      } catch {
        return;
      }
      const choice = obj.choices?.[0];
      const delta = choice?.delta ?? choice?.message;
      if (!delta) return;
      const calls = delta.tool_calls;
      if (calls && calls.length > 0) {
        sawTool = true;
        for (const call of calls) mergeOpenAiToolDelta(toolAcc, call);
      }
      const text = typeof delta.content === "string" ? delta.content : "";
      if (!text) return;
      content += text;
      if (!sawTool) options.onToken?.(text);
    };

    try {
      if (r.body) {
        const decoder = new TextDecoder();
        let buf = "";
        for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
          if (options.signal?.aborted) throw abortError();
          buf += decoder.decode(chunk, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) !== -1) {
            take(buf.slice(0, nl));
            buf = buf.slice(nl + 1);
          }
        }
        take(buf);
      }
    } catch (err) {
      // A user cancel must stay an abort. A budget abort during the body is the
      // same timeout the non-streaming path reports from `ollamaFetch`.
      if (options.signal?.aborted) throw err;
      if (isTimeoutError(err)) throw new OllamaTimeoutError("chat-with-tools-stream", timeoutMs, err);
      throw err;
    }
    if (options.signal?.aborted) throw abortError();
    const rawToolCalls = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => ({
        id: call.id,
        function: { name: call.name, arguments: call.arguments },
      }));
    if (rawToolCalls.some((call) => toolArgumentsMalformed(String(call.function.arguments ?? "")))) {
      return retryNonStreaming();
    }
    const toolCalls = normalizeOllamaToolCalls(rawToolCalls);
    if (content.length === 0 && toolCalls.length === 0) {
      return retryNonStreaming();
    }
    return { content, toolCalls };
  }
}

let defaultProvider: ModelProvider | null = null;

export function getModelProvider(): ModelProvider {
  if (!defaultProvider) defaultProvider = new OllamaClient();
  return defaultProvider;
}

export function setModelProvider(provider: ModelProvider): void {
  defaultProvider = provider;
}

export function resetModelProvider(): void {
  defaultProvider = null;
}

/** Clears cached undici agents/fetch (tests that mock `globalThis.fetch` need this between cases). */
export function resetOllamaHttpClient(): void {
  undiciFetch = null;
  ollamaAgentByTimeout.clear();
}
