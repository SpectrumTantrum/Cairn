// `ask` — a grounded, cited answer over the user's own notes. Retrieve the top-k chunks,
// hand ONLY those to the local chat model under strict grounding rules, and return the
// answer plus the numbered sources it was allowed to use. If retrieval finds nothing, refuse
// rather than answer from outside knowledge (the G10 "your notes don't cover this" gate).

import { coverageBand, search } from "./retrieve.js";
import type { Mode, SearchHit } from "./retrieve.js";
import type { Index } from "./vault-index.js";
import { resolveChatModel, chat } from "./chat.js";
import type { ChatSampling } from "./chat.js";

/** One retrieved chunk from the top-k classic Ask selects for the model. */
export interface AskTopChunk {
  file: string;
  id: number | null;
  heading: string;
  cosine: number | null;
}

export interface AskResult {
  answer: string;
  sources: SearchHit[];
  mode: "hybrid" | "lexical";
  grounded: boolean;
  model?: string;
  covered: boolean;
  reason?: string;
  /** Max dense cosine for this retrieval. NaN when the turn was lexical. */
  poolMaxCosine: number;
  /**
   * Top-k selected for the model. Present when the gate refuses before the
   * call too, so a legacy row still shows the chunks that were retrieved.
   */
  topChunks: AskTopChunk[];
}

/** Shown when classic Ask will not answer from the notes. */
export const UNCOVERED_ANSWER = "Your notes don't cover this.";

/**
 * Appended after the question only when retrieval is in the weak band.
 * The grounding system prompt and the warm prefix stay unchanged.
 */
export const WEAK_MATCH_NOTE = [
  "These notes may only partly cover the question.",
  "The question may use different words than the notes (for example \u2018throttle\u2019 or \u2018cap\u2019 for a rate limit); the answer may sit in a table or list.",
  'The answer may sit in a table, a list, or wording that differs from the question. Answer only from them, and cite each claim with [n]. If they do not contain the answer, reply exactly: "Your notes don\'t cover this."',
].join("\n");

/** True when classic prose cites a 1-based `[n]` source. `[path:line]` does not count. */
export function hasClassicCitation(answer: string): boolean {
  for (const match of answer.matchAll(/\[(\d+)\]/g)) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n >= 1) return true;
  }
  return false;
}

/**
 * Text classic Ask shows. A weak-band answer with no `[n]` becomes the refusal
 * sentence. So does an uncited answer in any band that contains that exact
 * sentence. A cited answer that quotes the sentence is left as written.
 */
export function presentClassicAnswer(raw: string, weak: boolean): { answer: string; suppressed: boolean } {
  const suppressed = !hasClassicCitation(raw) && (weak || raw.includes(UNCOVERED_ANSWER));
  return { answer: suppressed ? UNCOVERED_ANSWER : raw, suppressed };
}

/**
 * The grounding system prompt shared by `ask()` (single-turn) and `ChatThread`
 * (multi-turn). Exported so both grounded paths stay byte-identical — the
 * refusal string here is what the G10 coverage gate and the desktop UI match on.
 */
export const GROUNDING_SYSTEM = [
  "You are Cairn, a local knowledge assistant. Answer the user's question using ONLY the numbered SOURCES below — excerpts from the user's own notes.",
  "Rules:",
  "- Ground every claim in the sources and cite them inline with bracketed numbers, e.g. [1] or [2][3].",
  "- Use ONLY the sources. Do not add outside knowledge or invent details.",
  '- If the sources do not contain the answer, reply exactly: "Your notes don\'t cover this."',
  "- Be concise and direct; no preamble.",
].join("\n");

/** Stable start of a classic user turn. Background warm stops here so the prefix stays cached. */
export const CLASSIC_USER_PREFIX = "SOURCES:\n";

export function classicAskUserContent(sourcesBlock: string, question: string, weak = false): string {
  const body = `${CLASSIC_USER_PREFIX}${sourcesBlock}\n\nQUESTION: ${question}`;
  return weak ? `${body}\n\n${WEAK_MATCH_NOTE}` : body;
}

export type ClassicAskGate = "current" | "legacy";

export async function ask(
  index: Index,
  question: string,
  opts: {
    k?: number;
    mode?: Mode;
    model?: string;
    scope?: string[];
    coverageThreshold?: number;
    /**
     * `current` is the weak-band gate. `legacy` is the pre-#102 0.5-only path:
     * a cosine under 0.5 refuses before the model, with no weak note.
     * Uncited refusal-sentence normalization still runs in both gates.
     */
    gate?: ClassicAskGate;
    /**
     * Eval-only Ollama sampling. Omitted by the app, so desktop Ask keeps the
     * current request body.
     */
    temperature?: number;
    seed?: number;
  } = {},
): Promise<AskResult> {
  const gate = opts.gate ?? "current";
  if (gate !== "current" && gate !== "legacy") {
    throw new Error('ask gate must be "current" or "legacy"');
  }
  const k = opts.k ?? 6;
  const { hits, mode, coverage } = await search(index, question, {
    k,
    mode: opts.mode,
    scope: opts.scope,
    coverageThreshold: opts.coverageThreshold,
  });

  const band = coverageBand(coverage);
  const topChunks = topChunksOf(hits);
  const sampling = samplingOf(opts);
  // Legacy has no weak band: anything under the 0.5 threshold refuses, model uncalled.
  if (band === "refuse" || (gate === "legacy" && band === "weak")) {
    return {
      answer: UNCOVERED_ANSWER,
      sources: [],
      mode,
      grounded: false,
      covered: false,
      reason: "Retrieved context did not meet the coverage threshold.",
      poolMaxCosine: coverage.poolMaxCosine,
      topChunks,
    };
  }

  const model = await resolveChatModel(opts.model);
  const sourcesBlock = hits
    .map((h, i) => `[${i + 1}] ${h.file}:${h.line}${h.heading ? ` > ${h.heading}` : ""}\n${h.text}`)
    .join("\n\n");
  const weak = band === "weak";

  const raw = await chat(
    model,
    [
      { role: "system", content: GROUNDING_SYSTEM },
      { role: "user", content: classicAskUserContent(sourcesBlock, question, weak) },
    ],
    false,
    undefined,
    sampling,
  );

  // Uncited weak answers, and any uncited answer that contains the refusal
  // sentence, are replaced by that sentence alone.
  const { answer, suppressed } = presentClassicAnswer(raw, weak);
  if (suppressed) {
    return {
      answer,
      sources: [],
      mode,
      grounded: false,
      covered: false,
      model,
      poolMaxCosine: coverage.poolMaxCosine,
      topChunks,
    };
  }

  return {
    answer,
    sources: hits,
    mode,
    grounded: true,
    model,
    covered: true,
    poolMaxCosine: coverage.poolMaxCosine,
    topChunks,
  };
}

function topChunksOf(hits: SearchHit[]): AskTopChunk[] {
  return hits.map((hit) => ({
    file: hit.file,
    id: hit.id ?? null,
    heading: hit.heading,
    cosine: Number.isFinite(hit.cosine) ? hit.cosine : null,
  }));
}

function samplingOf(opts: { temperature?: number; seed?: number }): ChatSampling | undefined {
  if (opts.temperature === undefined && opts.seed === undefined) return undefined;
  const sampling: ChatSampling = {};
  if (opts.temperature !== undefined) {
    if (!Number.isFinite(opts.temperature)) throw new Error("ask temperature must be a finite number");
    sampling.temperature = opts.temperature;
  }
  if (opts.seed !== undefined) {
    if (!Number.isInteger(opts.seed)) throw new Error("ask seed must be an integer");
    sampling.seed = opts.seed;
  }
  return sampling;
}
