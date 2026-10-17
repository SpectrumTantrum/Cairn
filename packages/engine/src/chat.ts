// Local chat/generation via the ModelProvider seam — the "always-on model" (CONTEXT.md).
// Defaults to a Qwen3 chat model; thinking is disabled (think:false) to keep answers clean
// and fast. Override with CHAT_MODEL or --model.

import { getModelProvider, type ChatMessage, type ChatStreamCallbacks, type ModelProvider } from "./model-provider.js";
import { listModels } from "./embed.js";

export type { ChatMessage, ChatStreamCallbacks };

/**
 * Fresh-profile default for both Ask modes. `qwen3:8b` wins whenever it is
 * installed. The rest is the previous classic order, so a machine without 8b
 * still resolves the way classic Ask did. The list does not depend on mode:
 * toggling Agentic Ask must not swap models.
 */
const CHAT_MODEL_PREFER = ["qwen3:8b", "qwen3:4b", "qwen3", "llama3.2:3b", "llama3.2"] as const;

export interface ResolveChatModelOptions {
  /**
   * Accepted so callers can keep passing the Ask mode. It does not change the
   * model: both modes share `CHAT_MODEL_PREFER`.
   */
  agentic?: boolean;
}

/**
 * The chat model a fresh profile will actually send. Tag order from Ollama is ignored.
 * An explicit request wins. Otherwise `envModel` (CHAT_MODEL), then the preference list,
 * then any non-embedder. Returns null when nothing qualifies.
 */
export function pickChatModel(
  models: readonly string[],
  requested?: string,
  opts?: ResolveChatModelOptions & { envModel?: string },
): string | null {
  const exact = (want: string) => models.includes(want);
  const family = (want: string) => models.find((m) => m.split(":")[0] === want.split(":")[0]);
  const resolve = (want: string): string | null => (exact(want) ? want : (family(want) ?? null));

  if (requested) return resolve(requested);
  if (opts?.envModel) {
    const fromEnv = resolve(opts.envModel);
    if (fromEnv) return fromEnv;
  }
  for (const name of CHAT_MODEL_PREFER) {
    if (exact(name)) return name;
  }
  for (const name of CHAT_MODEL_PREFER) {
    const match = family(name);
    if (match) return match;
  }
  return models.find((m) => !/embed/i.test(m)) ?? null;
}

export async function resolveChatModel(requested?: string, opts?: ResolveChatModelOptions): Promise<string> {
  const models = await listModels();
  const picked = pickChatModel(models, requested, {
    agentic: opts?.agentic,
    envModel: requested ? undefined : process.env.CHAT_MODEL,
  });
  if (picked) return picked;
  if (requested) {
    throw new Error(`chat model "${requested}" not pulled (have: ${models.join(", ") || "none"})`);
  }
  throw new Error("no local chat model — `ollama pull qwen3:4b`");
}

export async function chat(
  model: string,
  messages: ChatMessage[],
  think = false,
  provider?: ModelProvider,
): Promise<string> {
  const raw = await (provider ?? getModelProvider()).chat(model, messages, think);
  return stripThinking(raw);
}

/**
 * Streaming counterpart to `chat()`. Forwards each token to `callbacks.onToken`
 * and resolves to the full (thinking-stripped) answer. Falls back to a single
 * `chat()` call — emitting the whole answer as one token — when the active
 * ModelProvider does not implement `chatStream`, so callers can always rely on
 * `onToken` firing at least once.
 *
 * `provider` overrides the global (Ollama) transport for THIS call only — the
 * cloud-escalation seam (ADR-0002). Retrieval/embeddings are unaffected: they run
 * on the global local provider, so grounding stays local even on an escalated turn.
 */
export async function chatStream(
  model: string,
  messages: ChatMessage[],
  callbacks?: ChatStreamCallbacks,
  think = false,
  provider?: ModelProvider,
): Promise<string> {
  const active = provider ?? getModelProvider();
  if (active.chatStream) {
    // Qwen3 can stream a `<think>` block inside `message.content` before the
    // answer. Strip it before `onToken` so the answer area never shows it.
    const filter = new ThinkingTokenFilter();
    const raw = await active.chatStream(
      model,
      messages,
      {
        ...callbacks,
        onToken: (token) => {
          const visible = filter.push(token);
          if (visible) callbacks?.onToken?.(visible);
        },
      },
      think,
    );
    const tail = filter.finish();
    if (tail) callbacks?.onToken?.(tail);
    return stripThinking(raw);
  }
  const answer = await chat(model, messages, think, provider);
  callbacks?.onToken?.(answer);
  return answer;
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

/**
 * Drops a Qwen thinking block as tokens arrive, including when the tags are
 * split across chunks. An unclosed block is discarded: it is reasoning, not
 * the answer.
 */
class ThinkingTokenFilter {
  private buf = "";
  private inside = false;

  push(chunk: string): string {
    this.buf += chunk;
    let out = "";
    while (this.buf.length > 0) {
      if (this.inside) {
        const at = indexOfIgnoreCase(this.buf, THINK_CLOSE);
        if (at === -1) {
          this.buf = this.buf.slice(this.buf.length - partialTagLength(this.buf, THINK_CLOSE));
          break;
        }
        this.buf = this.buf.slice(at + THINK_CLOSE.length);
        this.inside = false;
        continue;
      }
      const at = indexOfIgnoreCase(this.buf, THINK_OPEN);
      if (at === -1) {
        const keep = partialTagLength(this.buf, THINK_OPEN);
        out += this.buf.slice(0, this.buf.length - keep);
        this.buf = this.buf.slice(this.buf.length - keep);
        break;
      }
      out += this.buf.slice(0, at);
      this.buf = this.buf.slice(at + THINK_OPEN.length);
      this.inside = true;
    }
    return out;
  }

  finish(): string {
    if (this.inside) {
      this.buf = "";
      this.inside = false;
      return "";
    }
    const rest = this.buf;
    this.buf = "";
    return rest;
  }
}

function indexOfIgnoreCase(hay: string, needle: string): number {
  return hay.toLowerCase().indexOf(needle.toLowerCase());
}

function partialTagLength(buf: string, tag: string): number {
  const max = Math.min(buf.length, tag.length - 1);
  const lower = buf.toLowerCase();
  const want = tag.toLowerCase();
  for (let n = max; n > 0; n--) {
    if (want.startsWith(lower.slice(lower.length - n))) return n;
  }
  return 0;
}

function stripThinking(s: string): string {
  let out = s;
  const lower = out.toLowerCase();
  const lastClose = lower.lastIndexOf(THINK_CLOSE);
  if (lastClose !== -1) out = out.slice(lastClose + THINK_CLOSE.length);
  else {
    const open = lower.lastIndexOf(THINK_OPEN);
    if (open !== -1) out = out.slice(0, open);
  }
  return out.replace(/<\/?think>/gi, "").trim();
}
