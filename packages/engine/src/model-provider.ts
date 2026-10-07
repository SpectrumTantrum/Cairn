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
  try {
    return await fetch(url, opts as RequestInit);
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
  name: string;
  arguments: Record<string, unknown>;
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
  ): Promise<ToolTurn>;
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
  ): Promise<ToolTurn> {
    // Non-streaming on purpose (ADR-0008 §5: Ollama #15497 stream+tools bug).
    const body = {
      model,
      stream: false,
      think: false,
      tools: tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      messages: messages.map((m) => {
        if (m.role === "assistant" && m.toolCalls?.length) {
          return {
            role: "assistant",
            content: m.content,
            tool_calls: m.toolCalls.map((c) => ({
              function: { name: c.name, arguments: c.arguments },
            })),
          };
        }
        if (m.role === "tool") {
          return { role: "tool", content: m.content, tool_name: m.toolName };
        }
        return { role: m.role, content: m.content };
      }),
    };

    const r = await ollamaFetch(
      `${this.baseUrl}/api/chat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      OLLAMA_CHAT_TOOLS_TIMEOUT_MS,
      "chat-with-tools",
    );
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status} from /api/chat (tools): ${t.slice(0, 200)}`);
    }
    const j = (await r.json()) as {
      message?: {
        content?: string;
        tool_calls?: { function?: { name?: string; arguments?: unknown } }[];
      };
    };
    const rawCalls = j.message?.tool_calls ?? [];
    const toolCalls: ToolCall[] = [];
    for (const rc of rawCalls) {
      const name = rc.function?.name;
      if (typeof name !== "string" || name === "") continue;
      // Ollama returns arguments as an object; tolerate a JSON string too.
      let args = rc.function?.arguments;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      toolCalls.push({
        name,
        arguments: args && typeof args === "object" ? (args as Record<string, unknown>) : {},
      });
    }
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
