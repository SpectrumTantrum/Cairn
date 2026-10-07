// Local model transport seam (ADR-0002): Ollama today, BYOK cloud adapters later.
// HTTP only — no Electron/DOM. Callers use getModelProvider() or inject via setModelProvider() in tests.


// ---- Ollama HTTP budgets ----------------------------------------------------
// Node/Electron `fetch` is undici. Undici defaults `headersTimeout`/`bodyTimeout` to
// 300_000 ms (5 min). Non-streaming `/api/chat` (used by `chatWithTools`) does not
// send response headers until generation finishes, so a slow local model under load
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

async function ollamaFetch(url: string, init: RequestInit | undefined, timeoutMs: number, label: string): Promise<Response> {
  const dispatcher = await ollamaDispatcher(timeoutMs);
  const signal = AbortSignal.timeout(timeoutMs);
  const opts: Record<string, unknown> = { ...(init ?? {}), signal };
  if (dispatcher !== undefined) opts.dispatcher = dispatcher;
  const fetchFn = await ollamaFetchImpl();
  try {
    return await fetchFn(url, opts as RequestInit);
  } catch (err) {
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
   */
  requireToolCall?: boolean;
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
   * Optional tool-calling turn for the agent write-loop (ADR-0008). Runs
   * NON-STREAMING deliberately: Ollama's stream+tools path is buggy (#15497), and
   * the loop only needs the final tool-call batch, not token deltas. Providers that
   * cannot call tools omit this; the agent loop feature-detects and refuses cleanly.
   */
  chatWithTools?(
    model: string,
    messages: AgentMessage[],
    tools: ToolSchema[],
    options?: ChatWithToolsOptions,
  ): Promise<ToolTurn>;
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

export class OllamaClient implements ModelProvider {
  constructor(private readonly baseUrl = process.env.OLLAMA_HOST || "http://localhost:11434") {}

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
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        emit(buf.slice(0, nl), acc);
        buf = buf.slice(nl + 1);
      }
    }
    emit(buf, acc);
    return acc.full;
  }

  async chatWithTools(
    model: string,
    messages: AgentMessage[],
    tools: ToolSchema[],
    options?: ChatWithToolsOptions,
  ): Promise<ToolTurn> {
    // Non-streaming on purpose (ADR-0008 §5: Ollama #15497 stream+tools bug).
    const timeoutMs = options?.timeoutMs ?? OLLAMA_CHAT_TOOLS_TIMEOUT_MS;
    const ollamaTools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

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
      messages: messages.map((m) => {
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
      }),
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
