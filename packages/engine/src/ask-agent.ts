// Agentic Ask: bounded read-only tool loop (list / find / grep / read / open) over the vault.
// Hybrid retrieval is an optional *seed* — default path is FTS/grep + agent read, not a always-on
// RAG context bag (product bet: agentic search over notes).

import { search } from "./retrieve.js";
import type { Mode, SearchHit } from "./retrieve.js";
import type { Index } from "./vault-index.js";
import { resolveChatModel } from "./chat.js";
import {
  getModelProvider,
  OLLAMA_CHAT_TOOLS_TIMEOUT_MS,
  OllamaTimeoutError,
} from "./model-provider.js";
import type { AgentMessage } from "./model-provider.js";
import {
  ASK_SEARCH_TOOLS,
  labelAskSearchToolCall,
  runAskSearchTool,
  type AskSearchToolContext,
  type AskSearchToolState,
  type OpenAnchor,
} from "./agent-search-tools.js";

/** Incremental progress for long agentic Ask runs (tool steps / status). */
export type AskAgentProgress =
  | { kind: "status"; message: string }
  | { kind: "tool"; step: number; name: string; label: string };

/** Default hard step cap for read-only Ask agent loops (lower than write Agent ADR-0008). */
export const DEFAULT_ASK_AGENT_STEP_CAP = 16;

/**
 * Default wall-clock budget for one agentic Ask run (all tool turns combined).
 * Separates "one slow Ollama turn" (per-request OLLAMA_CHAT_TOOLS_TIMEOUT_MS) from
 * "the whole loop has been grinding too long" — under CPU thrash a 4B tool loop can
 * burn multiple minutes before undici's old 5-min headersTimeout would have fired.
 */
export const DEFAULT_ASK_AGENT_WALL_MS = 480_000;

/**
 * First tool-calling turn budget — fail faster than the 600s undici ceiling when a small
 * model ignores tools and burns the full generation budget (common on qwen3 under load).
 */
export const DEFAULT_ASK_AGENT_FIRST_TURN_TIMEOUT_MS = 180_000;

export type RetrievalSeedOption = boolean | { k?: number; mode?: Mode };

export interface AskAgentOptions {
  index: Index;
  question: string;
  /** Path-validated note reader (main process supplies the vault-scoped one). */
  readNote: (path: string) => Promise<string>;
  /** Per-page PDF text. Empty array means the file has no text layer. */
  readPdf?: (path: string) => Promise<{ page: number; text: string }[]>;
  /** Optional live vault listing; when omitted, `list` uses indexed paths only. */
  listNotes?: (prefix?: string) => Promise<string[]>;
  model?: string;
  stepCap?: number;
  /** Wall-clock budget for the whole loop (ms). Default DEFAULT_ASK_AGENT_WALL_MS. */
  wallMs?: number;
  mode?: Mode;
  scope?: string[];
  k?: number;
  /**
   * Optional hybrid/lexical retrieval seed prepended to the first turn.
   * Default `false` — the model should list/find/grep/read instead of relying on a RAG bag.
   */
  retrievalSeed?: RetrievalSeedOption;
  /** Fired during the loop so UIs can show tool-step progress instead of a silent spinner. */
  onProgress?: (event: AskAgentProgress) => void;
}

export interface AskAgentResult {
  answer: string;
  /** Chunks and notes the agent touched via find/grep/read/open (citation metadata). */
  sources: SearchHit[];
  /** UI open anchors the agent recorded via `open`. */
  opened: OpenAnchor[];
  /** Seed hits when retrievalSeed was enabled (not counted as "opened" by default). */
  seedHits: SearchHit[];
  steps: number;
  stopReason: "done" | "step-cap" | "timeout" | "no-tool-support" | "no-tool-use";
  grounded: boolean;
  model?: string;
}

const UNCOVERED = "Your notes don't cover this.";

const ASK_AGENT_SYSTEM = [
  "You are Cairn, a local knowledge assistant operating over the user's Markdown notes and text PDFs.",
  "Answer using ONLY information you gather with your tools — do not invent facts.",
  "Tools (read-only):",
  "- list(prefix?): list Markdown and PDF paths in the vault.",
  "- find(query, k?): search indexed chunks (hybrid or keyword). PDF chunks are keyword-only and include a page.",
  "- grep(pattern, path?, limit?): substring search over indexed chunks. PDF hits include a page.",
  "- read(path): read a note, or the text of each PDF page.",
  "- open(path, line?, heading?, page?): record a UI jump. For a PDF, pass the 1-based page.",
  "Workflow: use list/find/grep to discover relevant files, read them, then answer.",
  "On your FIRST turn you MUST call find or grep (or list, then read) — never answer with text only before using at least one search tool.",
  "Cite Markdown as [path:line]. Cite a PDF by its page.",
  "A PDF with no text layer cannot be read. Do not invent its contents.",
  `If the vault does not contain the answer after searching, reply exactly: "${UNCOVERED}"`,
  "When finished, stop calling tools and give a concise, direct answer.",
].join("\n");

function isPdfFile(file: string): boolean {
  return file.toLowerCase().endsWith(".pdf");
}

function sourceHasBody(hit: SearchHit): boolean {
  return Boolean(hit.text?.trim() || hit.snippet?.trim());
}

/**
 * Drop PDF sources that never yielded a page of text, and replace an invented
 * answer when the run touched a text-less PDF and gathered nothing else.
 * Leaves no-tool-use, timeout, and step-cap messages alone.
 */
function settleTextlessPdf(
  state: AskSearchToolState,
  stopReason: AskAgentResult["stopReason"],
  answer: string,
  seedHits: SearchHit[],
): Pick<AskAgentResult, "answer" | "sources" | "opened" | "grounded"> {
  const sources = state.sources.filter((hit) => {
    if (!isPdfFile(hit.file)) return true;
    return typeof hit.page === "number" && hit.page > 0 && sourceHasBody(hit);
  });
  const keptPdf = new Set(sources.filter((hit) => isPdfFile(hit.file)).map((hit) => hit.file));
  const opened = state.opened.filter((anchor) => {
    if (!isPdfFile(anchor.path)) return true;
    return keptPdf.has(anchor.path);
  });
  const anyBody = sources.some(sourceHasBody) || seedHits.some(sourceHasBody);
  let next = answer;
  if (state.textlessPdf && !anyBody && stopReason === "done") next = UNCOVERED;
  return {
    answer: next,
    sources,
    opened,
    grounded: sources.length > 0 || seedHits.length > 0,
  };
}

function seedEnabled(opt: RetrievalSeedOption | undefined): boolean {
  return opt !== undefined && opt !== false;
}

function buildUserTurn(question: string, seedBlock: string | null): string {
  if (seedBlock) {
    return `OPTIONAL SEED (retrieval hints — verify with tools):\n${seedBlock}\n\nQUESTION: ${question}`;
  }
  return `QUESTION: ${question}\n\nNo retrieval seed was injected — use list, find, grep, and read to gather context before answering.`;
}

/**
 * Run agentic Ask: tool loop with read-only vault tools. Does not write; does not call propose_edit.
 */
export async function runAskAgent(opts: AskAgentOptions): Promise<AskAgentResult> {
  const provider = getModelProvider();
  const stepCap = opts.stepCap ?? DEFAULT_ASK_AGENT_STEP_CAP;
  const wallMs = opts.wallMs ?? DEFAULT_ASK_AGENT_WALL_MS;
  const startedAt = Date.now();
  const defaultK = opts.k ?? 8;

  let seedHits: SearchHit[] = [];
  let seedBlock: string | null = null;
  if (seedEnabled(opts.retrievalSeed)) {
    const seedOpts = typeof opts.retrievalSeed === "object" ? opts.retrievalSeed : {};
    const k = seedOpts.k ?? defaultK;
    const mode = seedOpts.mode ?? opts.mode;
    const { hits } = await search(opts.index, opts.question, { k, mode, scope: opts.scope });
    seedHits = hits;
    if (hits.length > 0) {
      seedBlock = hits
        .map((h, i) => `[seed ${i + 1}] ${h.file}:${h.line}${h.heading ? ` > ${h.heading}` : ""}\n${h.text}`)
        .join("\n\n");
    }
  }

  if (!provider.chatWithTools) {
    return {
      answer:
        "This model does not support tool-calling, which agentic Ask needs. Pull a tool-capable local model (e.g. `ollama pull qwen3:4b`).",
      sources: [],
      opened: [],
      seedHits,
      steps: 0,
      stopReason: "no-tool-support",
      grounded: seedHits.length > 0,
    };
  }

  const model = await resolveChatModel(opts.model);
  const toolState: AskSearchToolState = { sources: [], opened: [] };
  const toolCtx: AskSearchToolContext = {
    index: opts.index,
    readNote: opts.readNote,
    readPdf: opts.readPdf,
    listNotes: opts.listNotes,
    scope: opts.scope,
    defaultMode: opts.mode,
    defaultK,
  };

  const messages: AgentMessage[] = [
    { role: "system", content: ASK_AGENT_SYSTEM },
    { role: "user", content: buildUserTurn(opts.question, seedBlock) },
  ];

  let steps = 0;
  let answer = "";
  let stopReason: AskAgentResult["stopReason"] = "done";
  const progress = (event: AskAgentProgress): void => {
    opts.onProgress?.(event);
  };

  progress({ kind: "status", message: "Starting agentic search…" });

  for (;;) {
    if (steps >= stepCap) {
      stopReason = "step-cap";
      break;
    }
    if (Date.now() - startedAt >= wallMs) {
      stopReason = "timeout";
      if (!answer) {
        answer =
          "Agentic Ask timed out before finishing. Retry when the machine is quieter, use a faster model, or turn off agentic Ask.";
      }
      break;
    }
    const remainingWallMs = wallMs - (Date.now() - startedAt);
    const firstTurn = steps === 0;
    progress({
      kind: "status",
      message: firstTurn
        ? "Waiting for the model to call search tools…"
        : `Thinking (step ${steps + 1})…`,
    });
    const turnBudget = Math.min(
      OLLAMA_CHAT_TOOLS_TIMEOUT_MS,
      firstTurn ? DEFAULT_ASK_AGENT_FIRST_TURN_TIMEOUT_MS : OLLAMA_CHAT_TOOLS_TIMEOUT_MS,
      Math.max(1, remainingWallMs),
    );
    let turn;
    try {
      turn = await provider.chatWithTools(model, messages, ASK_SEARCH_TOOLS, {
        timeoutMs: turnBudget,
        requireToolCall: firstTurn,
      });
    } catch (err) {
      const noGroundingYet = toolState.sources.length === 0 && seedHits.length === 0;
      if (firstTurn && noGroundingYet && err instanceof OllamaTimeoutError) {
        steps++;
        stopReason = "no-tool-use";
        answer =
          "Agentic Ask timed out waiting for the model to call search tools (often qwen3:4b or Qwen3 thinking+tools on older Ollama). Try qwen3:8b, upgrade Ollama, use classic Ask, or retry when the machine is quieter.";
        break;
      }
      throw err;
    }
    steps++;

    if (turn.toolCalls.length === 0) {
      progress({ kind: "status", message: "Composing answer…" });
      const noGroundingYet = toolState.sources.length === 0 && seedHits.length === 0;
      if (firstTurn && noGroundingYet) {
        stopReason = "no-tool-use";
        answer =
          turn.content.trim() ||
          "Agentic Ask needs at least one search tool call before answering. This model replied without using tools — try qwen3:8b (not 4b), use classic Ask, or upgrade Ollama if Qwen3 thinking blocked tools.";
      } else {
        answer = turn.content;
        stopReason = "done";
      }
      break;
    }

    messages.push({ role: "assistant", content: turn.content, toolCalls: turn.toolCalls });

    for (const call of turn.toolCalls) {
      const label = labelAskSearchToolCall(call.name, call.arguments);
      progress({ kind: "tool", step: steps, name: call.name, label });
      const content = await runAskSearchTool(call.name, call.arguments, toolCtx, toolState);
      messages.push({
        role: "tool",
        toolName: call.name,
        toolCallId: call.id,
        content,
      });
    }
  }

  const settled = settleTextlessPdf(toolState, stopReason, answer, seedHits);

  return {
    answer: settled.answer,
    sources: settled.sources,
    opened: settled.opened,
    seedHits,
    steps,
    stopReason,
    grounded: settled.grounded,
    model,
  };
}
