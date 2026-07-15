// Studio grounded-generation pipeline (issue #26). ONE shared path for every template:
//   (1) retrieve scoped context from the index — the SAME hybrid/lexical arms as ask/chat,
//   (2) generate a structured note via the local chat-model seam (ModelProvider — NO new
//       model transport), and
//   (3) return a note that carries citations back to its sources.
//
// Citations are the product's spine, so the pipeline DETERMINISTICALLY appends a
// "## Sources" section derived from the retrieved hits — provenance never depends on the
// model remembering to write one. The refusal contract matches ask(): if retrieval does not
// cover the topic, we return no note rather than generate from outside knowledge.
//
// The engine NEVER writes (ADR-0008): this returns proposed note CONTENT. The generated note
// enters the vault only through the write-safety checkpoint/apply machinery downstream (the
// desktop wraps this result in an EditProposal and drives the same agent apply/revert IPC).

import { search } from "./retrieve.js";
import type { Mode, SearchHit } from "./retrieve.js";
import type { Index } from "./vault-index.js";
import { resolveChatModel, chat } from "./chat.js";
import { getStudioTemplate } from "./studio-templates.js";

export interface StudioGenerateOptions {
  index: Index;
  templateId: string;
  /** The subject the note is built around — also used as the retrieval query. */
  topic: string;
  model?: string;
  k?: number;
  mode?: Mode;
  scope?: string[];
  coverageThreshold?: number;
}

/** A proposed note: default vault-relative path (writer resolves collisions) + full content. */
export interface GeneratedNote {
  path: string;
  content: string;
}

export interface StudioGenerateResult {
  /** Template id this note was generated from. */
  template: string;
  title: string;
  /** A short line for the chat surface summarising the result (or the refusal reason). */
  answer: string;
  /** The proposed note, or null when retrieval did not cover the topic (refusal). */
  note: GeneratedNote | null;
  sources: SearchHit[];
  mode: "hybrid" | "lexical";
  grounded: boolean;
  covered: boolean;
  reason?: string;
  model?: string;
}

/**
 * Grounding preamble shared by every Studio template — the byte-identical sibling of
 * ask()/ChatThread's GROUNDING_SYSTEM, specialised for producing a NEW note. The
 * per-template `structure` guidance is appended after this.
 */
const STUDIO_SYSTEM = [
  "You are Cairn's Studio generator. Produce a new Markdown note grounded ONLY in the numbered SOURCES below — excerpts from the user's own notes.",
  "Rules:",
  "- Ground every claim in the sources and cite them inline with bracketed numbers, e.g. [1] or [2][3].",
  "- Use ONLY the sources. Do not add outside knowledge or invent details.",
  "- Write clean Markdown and follow the requested structure exactly.",
].join("\n");

/** The deterministic "## Sources" provenance block appended to every generated note. */
function sourcesSection(hits: SearchHit[]): string {
  const lines = hits.map(
    (h, i) => `${i + 1}. [[${h.file}]]${h.heading ? ` — ${h.heading}` : ""} (line ${h.line})`,
  );
  return `## Sources\n\n${lines.join("\n")}\n`;
}

/** Sanitise a topic into a filesystem-safe note basename fragment. */
function slugForFilename(topic: string): string {
  const cleaned = topic
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 60 ? cleaned.slice(0, 60).trim() : cleaned;
}

/**
 * Run the shared grounded-generation pipeline for one template. Retrieves, refuses when
 * uncovered, otherwise generates and returns a cited note proposal. Applies nothing.
 */
export async function generateStudioNote(opts: StudioGenerateOptions): Promise<StudioGenerateResult> {
  const template = getStudioTemplate(opts.templateId);
  if (!template) {
    throw new Error(`Unknown Studio template "${opts.templateId}".`);
  }
  if (!template.enabled || !template.prompt) {
    throw new Error(`The "${template.title}" generator is not available yet.`);
  }
  const topic = opts.topic.trim();
  if (!topic) {
    throw new Error("Studio needs a topic to generate from.");
  }

  const k = opts.k ?? 6;
  const { hits, mode, coverage } = await search(opts.index, topic, {
    k,
    mode: opts.mode,
    scope: opts.scope,
    coverageThreshold: opts.coverageThreshold,
  });

  // Refusal contract (identical to ask()): do not generate from outside knowledge.
  if (!coverage.covered) {
    return {
      template: template.id,
      title: template.title,
      answer: "Your notes don't cover this.",
      note: null,
      sources: [],
      mode,
      grounded: false,
      covered: false,
      reason: "Retrieved context did not meet the coverage threshold.",
    };
  }

  const model = await resolveChatModel(opts.model);
  const sourcesBlock = hits
    .map((h, i) => `[${i + 1}] ${h.file}:${h.line}${h.heading ? ` > ${h.heading}` : ""}\n${h.text}`)
    .join("\n\n");

  const body = await chat(model, [
    { role: "system", content: `${STUDIO_SYSTEM}\n\n${template.prompt.structure}` },
    { role: "user", content: `SOURCES:\n${sourcesBlock}\n\nTOPIC: ${topic}` },
  ]);

  const heading = `# ${template.title}: ${topic}`;
  const content = `${heading}\n\n${body.trim()}\n\n${sourcesSection(hits)}`;
  const path = `${template.prompt.filenameStem} - ${slugForFilename(topic)}.md`;

  return {
    template: template.id,
    title: template.title,
    answer: `Generated a ${template.title.toLowerCase()} on “${topic}”, grounded in ${hits.length} source${hits.length === 1 ? "" : "s"}.`,
    note: { path, content },
    sources: hits,
    mode,
    grounded: true,
    covered: true,
    model,
  };
}
