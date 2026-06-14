// `ask` — a grounded, cited answer over the user's own notes. Retrieve the top-k chunks,
// hand ONLY those to the local chat model under strict grounding rules, and return the
// answer plus the numbered sources it was allowed to use. If retrieval finds nothing, refuse
// rather than answer from outside knowledge (the G10 "your notes don't cover this" gate).

import { search } from "./retrieve.ts";
import type { Mode, SearchHit } from "./retrieve.ts";
import type { Store } from "./store.ts";
import { resolveChatModel, chat } from "./chat.ts";

export interface AskResult {
  answer: string;
  sources: SearchHit[];
  mode: "hybrid" | "lexical";
  grounded: boolean;
  model?: string;
}

const SYSTEM = [
  "You are Cairn, a local knowledge assistant. Answer the user's question using ONLY the numbered SOURCES below — excerpts from the user's own notes.",
  "Rules:",
  "- Ground every claim in the sources and cite them inline with bracketed numbers, e.g. [1] or [2][3].",
  "- Use ONLY the sources. Do not add outside knowledge or invent details.",
  '- If the sources do not contain the answer, reply exactly: "Your notes don\'t cover this."',
  "- Be concise and direct; no preamble.",
].join("\n");

export async function ask(
  store: Store,
  question: string,
  opts: { k?: number; mode?: Mode; model?: string } = {},
): Promise<AskResult> {
  const k = opts.k ?? 6;
  const { hits, mode } = await search(store, question, { k, mode: opts.mode });

  if (hits.length === 0) {
    return {
      answer: "Your notes don't cover this — no relevant passages were found.",
      sources: [],
      mode,
      grounded: false,
    };
  }

  const model = await resolveChatModel(opts.model);
  const sourcesBlock = hits
    .map((h, i) => `[${i + 1}] ${h.file}:${h.line}${h.heading ? ` > ${h.heading}` : ""}\n${h.text}`)
    .join("\n\n");

  const answer = await chat(model, [
    { role: "system", content: SYSTEM },
    { role: "user", content: `SOURCES:\n${sourcesBlock}\n\nQUESTION: ${question}` },
  ]);

  return { answer, sources: hits, mode, grounded: true, model };
}
