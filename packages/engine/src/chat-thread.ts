// Multi-turn grounded chat over a vault. A ChatThread holds ordered messages and a
// `send()` that, per turn: (a) runs grounded retrieval on the new user turn, (b) calls
// the always-on model with the prior thread history + the retrieved SOURCES block, and
// (c) returns the same grounded/covered/citations metadata `ask()` returns today.
//
// This is the multi-turn sibling of single-turn `ask()` (ask.ts is left untouched). It
// reuses the exact same GROUNDING_SYSTEM prompt and coverage-refusal so a chat turn and a
// one-shot ask stay behaviourally identical on grounding. Streaming is opt-in via
// `onToken` — the token stream flows through the ModelProvider seam (chatStream), so an
// Electron IPC bridge can forward each token without the engine knowing about IPC.

import { alignClockCitations } from "./cite-align.js";
import { search } from "./retrieve.js";
import type { Mode, SearchHit } from "./retrieve.js";
import type { Index } from "./vault-index.js";
import { resolveChatModel, chat, chatStream } from "./chat.js";
import type { ChatMessage, ChatUsage, ModelProvider } from "./model-provider.js";
import { classicAskUserContent, GROUNDING_SYSTEM } from "./ask.js";

/** One recorded turn in a thread. Assistant turns carry the sources they were grounded in. */
export interface ThreadTurn {
  role: "user" | "assistant";
  content: string;
  sources?: SearchHit[];
  grounded?: boolean;
  covered?: boolean;
}

/** Thread-level defaults, applied to every `send()` unless overridden per call. */
export interface ChatThreadOptions {
  k?: number;
  mode?: Mode;
  model?: string;
  scope?: string[];
  coverageThreshold?: number;
}

/** Per-`send()` options. Any field overrides the thread-level default for that turn. */
export interface ChatSendOptions {
  k?: number;
  mode?: Mode;
  model?: string;
  scope?: string[];
  coverageThreshold?: number;
  /** Opt into token-by-token streaming; receives each delta as the model produces it. */
  onToken?: (token: string) => void;
  /**
   * Cloud-escalation transport (ADR-0002). When set, THIS turn's chat call routes to
   * the supplied provider instead of the global local one; `model` is used verbatim
   * (no local pulled-model validation). Retrieval still runs on the local provider, so
   * grounding stays local. The turn is flagged `escalated` and reports `usage`/`sent`.
   */
  provider?: ModelProvider;
  /** Cancels the model call. Retrieval may finish; the turn is not recorded. */
  signal?: AbortSignal;
}

/** What an escalated turn actually transmitted — surfaced for the "what was sent" disclosure. */
export interface SentPayload {
  system: string;
  sourcesBlock: string;
  question: string;
  /** Number of prior thread turns included as conversation history. */
  historyTurns: number;
}

/** Result of one `send()` — mirrors AskResult's grounding fields for a single turn. */
export interface ChatSendResult {
  answer: string;
  sources: SearchHit[];
  mode: "hybrid" | "lexical";
  grounded: boolean;
  covered: boolean;
  model?: string;
  reason?: string;
  /** True when the turn was routed to a BYOK cloud provider (ADR-0002). */
  escalated?: boolean;
  /** Token/cost accounting, only when a cloud provider reported it. */
  usage?: ChatUsage;
  /** Exactly what was transmitted on an escalated turn (inspectable in the UI). */
  sent?: SentPayload;
}

export class ChatThread {
  private readonly turns: ThreadTurn[] = [];

  constructor(
    private readonly index: Index,
    private readonly opts: ChatThreadOptions = {},
  ) {}

  /** Ordered, read-only view of the conversation so far. */
  get messages(): readonly ThreadTurn[] {
    return this.turns;
  }

  async send(userText: string, send: ChatSendOptions = {}): Promise<ChatSendResult> {
    const k = send.k ?? this.opts.k ?? 6;
    const mode = send.mode ?? this.opts.mode;
    const scope = send.scope ?? this.opts.scope;
    const coverageThreshold = send.coverageThreshold ?? this.opts.coverageThreshold;

    // History as the model should see it — captured BEFORE we record this user turn.
    const history: ChatMessage[] = this.turns.map((t) => ({ role: t.role, content: t.content }));
    const turn: ThreadTurn = { role: "user", content: userText };
    this.turns.push(turn);
    // Drop this exact turn on abort, even if a newer send has already appended
    // after it. The listener runs inside abort(), before that newer send reads history.
    const dropAbortedTurn = () => {
      const at = this.turns.indexOf(turn);
      if (at < 0) return;
      if (this.turns[at + 1]?.role === "assistant") return;
      this.turns.splice(at, 1);
    };
    const onAbort = () => dropAbortedTurn();
    send.signal?.addEventListener("abort", onAbort);

    try {
      return await this.completeSend(userText, history, send, k, mode, scope, coverageThreshold);
    } catch (err) {
      if (send.signal?.aborted) dropAbortedTurn();
      throw err;
    } finally {
      send.signal?.removeEventListener("abort", onAbort);
    }
  }

  private async completeSend(
    userText: string,
    history: ChatMessage[],
    send: ChatSendOptions,
    k: number,
    mode: Mode | undefined,
    scope: string[] | undefined,
    coverageThreshold: number | undefined,
  ): Promise<ChatSendResult> {
    if (send.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    const { hits, mode: usedMode, coverage } = await search(this.index, userText, {
      k,
      mode,
      scope,
      coverageThreshold,
    });

    if (send.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    if (!coverage.covered) {
      const answer = "Your notes don't cover this.";
      this.turns.push({ role: "assistant", content: answer, sources: [], grounded: false, covered: false });
      return {
        answer,
        sources: [],
        mode: usedMode,
        grounded: false,
        covered: false,
        reason: "Retrieved context did not meet the coverage threshold.",
      };
    }

    // Escalation uses the model id verbatim (it names a cloud model, not a pulled
    // Ollama tag); the local path validates the model is actually installed.
    const provider = send.provider;
    const model = provider
      ? (send.model ?? this.opts.model ?? "")
      : await resolveChatModel(send.model ?? this.opts.model);
    const sourcesBlock = hits
      .map((h, i) => `[${i + 1}] ${h.file}:${h.line}${h.heading ? ` > ${h.heading}` : ""}\n${h.text}`)
      .join("\n\n");

    const messages: ChatMessage[] = [
      { role: "system", content: GROUNDING_SYSTEM },
      ...history,
      { role: "user", content: classicAskUserContent(sourcesBlock, userText) },
    ];

    // Escalated turns always stream (cloud adapters report usage on the SSE tail).
    // A signal-bearing local turn also streams so the abort reaches the model call
    // even when the caller did not ask for tokens.
    let usage: ChatUsage | undefined;
    const raw =
      provider || send.onToken || send.signal
        ? await chatStream(
            model,
            messages,
            {
              onToken: send.onToken,
              onUsage: (u) => {
                usage = u;
              },
              signal: send.signal,
            },
            false,
            provider,
          )
        : await chat(model, messages);
    // Settled prose uses the renumbered marker. A live token stream may still
    // show the model's original [n] until the turn is replaced with this answer.
    const answer = alignClockCitations(raw, hits);

    this.turns.push({ role: "assistant", content: answer, sources: hits, grounded: true, covered: true });
    const result: ChatSendResult = {
      answer,
      sources: hits,
      mode: usedMode,
      grounded: true,
      covered: true,
      model,
    };
    if (provider) {
      result.escalated = true;
      if (usage) result.usage = usage;
      result.sent = {
        system: GROUNDING_SYSTEM,
        sourcesBlock,
        question: userText,
        historyTurns: history.length,
      };
    }
    return result;
  }
}
