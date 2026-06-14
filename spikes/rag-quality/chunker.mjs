// Structure-aware markdown chunker for the rag-quality fixture corpus.
//
// Mirrors the LOCKED chunking decision (ADR-0006 / engineering-decisions §G6) at
// the level this spike needs: split markdown STRUCTURE-FIRST by heading hierarchy
// (H1 title > H2 sections), then size-cap any section that exceeds the 512-token
// target with a recursive separator-respecting split. Token length is the pinned
// char-approximation at 3.5 chars/token (§G6), so the 512-token cap ≈ 1792 chars.
//
// The fixture notes are authored so every H2 section is < the cap, which means
// structure-first chunking produces exactly ONE chunk per section and the size-cap
// path never fires. That is deliberate: it keeps chunk boundaries DETERMINISTIC so
// each eval question's expected fact lives in exactly one chunk's core — splitter
// artifacts (overlap regions, mid-section cuts) can't manufacture false MISSes that
// aren't the embedder's fault. The size-cap code below is still implemented (and
// honest) so a longer note would chunk per the real config.
//
// Stable ids: chunks are numbered sequentially in (filename-sorted, in-file order),
// so the EVAL pairs reference a fixed id. A guard in retrieval.mjs asserts every
// expected_chunk_id exists, so re-running the chunker can't silently desync the evals.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const NOTES_DIR = join(HERE, 'notes');

const CHARS_PER_TOKEN = 3.5;        // §G6 pinned token-length approximation
const TARGET_TOKENS = 512;          // §G6 target chunk size
const OVERLAP_PCT = 0.15;           // §G6 15% overlap (only used on size-cap path)
const MAX_CHARS = Math.round(TARGET_TOKENS * CHARS_PER_TOKEN);        // ≈ 1792
const OVERLAP_CHARS = Math.round(MAX_CHARS * OVERLAP_PCT);            // ≈ 269

// Recursive separator-respecting split for an oversized section (§G6 splitter).
// Only fires if a section exceeds MAX_CHARS; the fixture is authored so it doesn't.
function recursiveSplit(text, maxChars, overlap) {
  if (text.length <= maxChars) return [text];
  const separators = ['\n\n', '\n', '. ', ' '];
  // Find the largest separator that lets us cut at/under maxChars.
  for (const sep of separators) {
    const cut = text.lastIndexOf(sep, maxChars);
    if (cut > 0) {
      const head = text.slice(0, cut + sep.length).trim();
      const restStart = Math.max(0, cut + sep.length - overlap);
      const tail = text.slice(restStart).trim();
      return [head, ...recursiveSplit(tail, maxChars, overlap)];
    }
  }
  // No separator found within the window — hard cut.
  return [
    text.slice(0, maxChars).trim(),
    ...recursiveSplit(text.slice(maxChars - overlap).trim(), maxChars, overlap),
  ];
}

// Parse one markdown note into { title (H1), sections: [{ heading, body }] }.
function parseNote(md) {
  const lines = md.split('\n');
  let title = '';
  const sections = [];
  let cur = null;
  for (const line of lines) {
    const h1 = line.match(/^#\s+(.*)$/);
    const h2 = line.match(/^##\s+(.*)$/);
    if (h1) {
      title = h1[1].trim();
    } else if (h2) {
      if (cur) sections.push(cur);
      cur = { heading: h2[1].trim(), bodyLines: [] };
    } else if (cur) {
      cur.bodyLines.push(line);
    }
  }
  if (cur) sections.push(cur);
  return {
    title,
    sections: sections.map((s) => ({ heading: s.heading, body: s.bodyLines.join('\n').trim() })),
  };
}

// Build the full chunk list with stable sequential ids.
export function buildChunks() {
  const files = readdirSync(NOTES_DIR).filter((f) => f.endsWith('.md')).sort();
  const chunks = [];
  let nextId = 1;
  for (const file of files) {
    const md = readFileSync(join(NOTES_DIR, file), 'utf8');
    const { title, sections } = parseNote(md);
    for (const section of sections) {
      const headingPath = `${title} > ${section.heading}`;
      const pieces = recursiveSplit(section.body, MAX_CHARS, OVERLAP_CHARS);
      pieces.forEach((piece) => {
        chunks.push({
          id: nextId++,
          source_type: 'note',
          file: `notes/${file}`,
          page: null,
          heading_path: headingPath,
          // The chunk text the embedder sees. PRODUCTION embeds BODY-ONLY: G5 keeps
          // heading_path in a SEPARATE column from chunks.text, the embedding cache
          // is keyed on chunks.text, and FTS5 is external-content over chunks.text —
          // heading_path is recorded "for G8 anchoring", NOT concatenated into the
          // embedded text. So body-only is the faithful default. EMBED_HEADINGS=1
          // prepends the heading_path to probe how much lexical title-overlap would
          // inflate the (esp. exact-term) numbers — a confound diagnostic, not the
          // production config.
          text: process.env.EMBED_HEADINGS === '1' ? `${headingPath}\n${piece}` : piece,
        });
      });
    }
  }
  return chunks;
}

// Run directly: print a manifest of (id, heading_path, char count) for authoring evals.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const chunks = buildChunks();
  for (const c of chunks) {
    console.log(`${String(c.id).padStart(3)}  ${c.heading_path}  [${c.text.length} chars]`);
  }
  console.log(`\n${chunks.length} chunks from notes/`);
}
