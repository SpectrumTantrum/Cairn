// G6 — structure-aware chunking with citation provenance.
//
// The recursive splitter (paragraph -> line -> sentence -> word -> char) is the same one
// the chunk-cache spike measured at ~94% edit-stability. Beyond the spike, we recover each
// chunk's source location (nearest heading + 1-based start line) so a search result can
// cite back to the spot in the file. Anchoring is intentionally FUZZY (ADR-0007): we locate
// each chunk by a text probe rather than exact offsets, which is robust to the splitter's
// separator handling and good enough to "jump to roughly here".

import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

const CHARS_PER_TOKEN = 3.5; // G6 pinned char-approximation
const TARGET_TOKENS = 512;
const OVERLAP_PCT = 0.15;
const TARGET_CHARS = Math.round(TARGET_TOKENS * CHARS_PER_TOKEN); // ~1792
const OVERLAP_CHARS = Math.round(TARGET_CHARS * OVERLAP_PCT); // ~269
const SEPARATORS = ["\n\n", "\n", ". ", " ", ""]; // G6 recursive order

export interface Chunk {
  text: string;
  ordinal: number; // 0-based position within the file
  line: number; // 1-based line where the chunk starts
  heading: string; // nearest preceding Markdown heading, or ""
}

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: TARGET_CHARS,
  chunkOverlap: OVERLAP_CHARS,
  separators: SEPARATORS,
});

export async function chunkMarkdown(text: string): Promise<Chunk[]> {
  const pieces = await splitter.splitText(text);
  const chunks: Chunk[] = [];
  let cursor = 0;
  pieces.forEach((piece, ordinal) => {
    const probe = piece.trimStart().slice(0, 64);
    let idx = probe ? text.indexOf(probe, cursor) : -1;
    if (idx === -1) idx = text.indexOf(piece.trimStart().slice(0, 16), cursor);
    if (idx === -1) idx = Math.min(cursor, Math.max(0, text.length - 1));
    const line = text.slice(0, idx).split("\n").length; // 1-based
    chunks.push({ text: piece, ordinal, line, heading: headingFor(piece, text, idx) });
    cursor = idx + 1; // advance so overlap doesn't re-match an earlier occurrence
  });
  return chunks;
}

// If the chunk itself opens on a heading, cite that; otherwise the nearest heading
// above where the chunk starts.
function headingFor(piece: string, text: string, offset: number): string {
  const firstLine = (piece.split("\n").find((l) => l.trim().length > 0) ?? "").trim();
  const self = /^#{1,6}[ \t]+(.+)$/.exec(firstLine);
  if (self) return self[1].trim();
  return nearestHeading(text, offset);
}

function nearestHeading(text: string, offset: number): string {
  const before = text.slice(0, offset);
  const matches = before.match(/^#{1,6}[ \t]+.+$/gm);
  if (!matches || matches.length === 0) return "";
  return matches[matches.length - 1].replace(/^#{1,6}[ \t]+/, "").trim();
}
