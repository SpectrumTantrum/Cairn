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
import { HTML_NO_TEXT } from "./html-text.js";
import { EMPTY_TABLE_MESSAGE, INVALID_UTF8_MESSAGE } from "./utf8-text.js";

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
  "You are Cairn, a local knowledge assistant operating over the user's Markdown notes, plain text files, CSV and TSV files, HTML files, and text PDFs.",
  "Answer using ONLY information you gather with your tools — do not invent facts.",
  "Tools (read-only):",
  "- list(prefix?): list Markdown, plain text, CSV, TSV, HTML, and PDF paths in the vault.",
  "- find(query, k?): search indexed chunks (hybrid or keyword). PDF chunks are keyword-only and include a page.",
  "- grep(pattern, path?, limit?): substring search over indexed chunks. PDF hits include a page.",
  "- read(path): read a Markdown note, a plain text file, a CSV or TSV file (rows, including the header), the visible text of an HTML file, or the text of each PDF page.",
  "- open(path, line?, heading?, page?): record a UI jump. For a PDF, pass the 1-based page. A plain text, CSV, TSV, or HTML file opens at a line, like a note.",
  "Workflow: use list/find/grep to discover relevant files, read them, then answer.",
  "On your FIRST turn you MUST call find or grep (or list, then read) — never answer with text only before using at least one search tool.",
  "Cite Markdown, plain text, CSV, TSV, and HTML as [path:line]. Cite a PDF by its page.",
  "A PDF with no text layer cannot be read. A file that is not valid UTF-8 text cannot be read. An empty CSV or TSV file cannot be read. An HTML file with no visible text cannot be read. Do not invent their contents.",
  "If the question names a file that cannot be read, do not answer from any other file.",
  `If the vault does not contain the answer after searching, reply exactly: "${UNCOVERED}"`,
  "When finished, stop calling tools and give a concise, direct answer.",
].join("\n");

function isPdfFile(file: string): boolean {
  return file.toLowerCase().endsWith(".pdf");
}

function normalizeVaultPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** File paths written in the question, in order, without duplicates. */
function filesNamedInQuestion(question: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const named = /[\w./\\-]+\.(?:markdown|txt|csv|tsv|pdf|html|htm|md)\b/gi;
  for (const match of question.matchAll(named)) {
    const norm = normalizeVaultPath(match[0]);
    const key = norm.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(norm);
  }
  return out;
}

function indexContainsFile(index: Index, name: string): boolean {
  const key = normalizeVaultPath(name).toLowerCase();
  for (const file of index.listFiles()) {
    const norm = normalizeVaultPath(file).toLowerCase();
    if (norm === key || norm.endsWith(`/${key}`)) return true;
  }
  return false;
}

function isHtmlFile(file: string): boolean {
  return /\.html?$/i.test(file);
}

function isTableFile(file: string): boolean {
  return /\.(csv|tsv)$/i.test(file);
}

/**
 * The question names a file the index skipped: invalid UTF-8 text, an empty CSV or
 * TSV, an HTML file with no visible text, or a PDF with no text layer.
 * A readable indexed file does not count.
 */
async function questionNamesUnreadableFile(opts: AskAgentOptions): Promise<boolean> {
  for (const name of filesNamedInQuestion(opts.question)) {
    if (indexContainsFile(opts.index, name)) continue;
    const lower = name.toLowerCase();
    if (lower.endsWith(".pdf")) {
      if (!opts.readPdf) continue;
      try {
        const pages = await opts.readPdf(name);
        if (pages.length === 0) return true;
      } catch {
        // A missing path is not a skipped file.
      }
      continue;
    }
    if (isTableFile(lower)) {
      try {
        const text = await opts.readNote(name);
        if (!text.trim()) return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === INVALID_UTF8_MESSAGE || message === EMPTY_TABLE_MESSAGE) return true;
      }
      continue;
    }
    if (isHtmlFile(lower)) {
      try {
        const text = await opts.readNote(name);
        if (!text.trim()) return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === INVALID_UTF8_MESSAGE || message === HTML_NO_TEXT) return true;
      }
      continue;
    }
    if (!lower.endsWith(".txt")) continue;
    try {
      await opts.readNote(name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === INVALID_UTF8_MESSAGE) return true;
    }
  }
  return false;
}

function honestMiss(): AskAgentResult {
  return {
    answer: UNCOVERED,
    sources: [],
    opened: [],
    seedHits: [],
    steps: 0,
    stopReason: "done",
    grounded: false,
  };
}

function sourceHasBody(hit: SearchHit): boolean {
  return Boolean(hit.text?.trim() || hit.snippet?.trim());
}

/**
 * Drop PDF sources that never yielded a page of text, drop HTML sources with no
 * visible text, drop CSV/TSV sources with no body, and replace an invented answer
 * when the run touched a text-less PDF, an empty HTML file, an empty or unreadable
 * table, or an unreadable text file and gathered nothing else.
 * Leaves no-tool-use, timeout, and step-cap messages alone.
 */
function settleTextlessPdf(
  state: AskSearchToolState,
  stopReason: AskAgentResult["stopReason"],
  answer: string,
  seedHits: SearchHit[],
): Pick<AskAgentResult, "answer" | "sources" | "opened" | "grounded"> {
  const sources = state.sources.filter((hit) => {
    if (isPdfFile(hit.file)) return typeof hit.page === "number" && hit.page > 0 && sourceHasBody(hit);
    if (state.textlessHtml && isHtmlFile(hit.file)) return sourceHasBody(hit);
    if (state.unreadableText && isTableFile(hit.file)) return sourceHasBody(hit);
    return true;
  });
  const keptPdf = new Set(sources.filter((hit) => isPdfFile(hit.file)).map((hit) => hit.file));
  const keptHtml = new Set(sources.filter((hit) => isHtmlFile(hit.file)).map((hit) => hit.file));
  const keptTables = new Set(sources.filter((hit) => isTableFile(hit.file)).map((hit) => hit.file));
  const opened = state.opened.filter((anchor) => {
    if (isPdfFile(anchor.path)) return keptPdf.has(anchor.path);
    if (state.textlessHtml && isHtmlFile(anchor.path)) return keptHtml.has(anchor.path);
    if (state.unreadableText && isTableFile(anchor.path)) return keptTables.has(anchor.path);
    return true;
  });
  const anyBody = sources.some(sourceHasBody) || seedHits.some(sourceHasBody);
  let next = answer;
  if ((state.textlessPdf || state.unreadableText || state.textlessHtml) && !anyBody && stopReason === "done") {
    next = UNCOVERED;
  }
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
  // A named skipped file is the whole question. Do not let a neighbor note answer it.
  if (await questionNamesUnreadableFile(opts)) return honestMiss();

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
