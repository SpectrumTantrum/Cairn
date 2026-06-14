// Spike (SCAFFOLD): does the TS per-chunk embedding cache keep edits cheap?
//
// TS port of the IDEA in spikes/mneme/chunk_cache.py + chunk_cache_v2.py, now that
// the engine is TS (ADR-0001). The cache is keyed on (chunk_hash, embedder_id,
// dimension) per the locked model-strategy decision; chunk_hash = SHA-256 of the
// NORMALIZED chunk text (G6/G7: collapse whitespace + NFC + LF before hashing).
//
// What this proves: re-embedding cost is bounded to the edit. We chunk a markdown
// doc (512-tok target / 15% overlap, separator-respecting), hash each chunk, then
// measure how many chunk_hashes SURVIVE two perturbations:
//   (a) one paragraph rewritten mid-document  (the headline cheap-edit case)
//   (b) a simulated PDF re-extraction with minor reflow (the A4 determinism risk)
// hit-rate = surviving chunks / chunks-after. Misses = vectors we must recompute.
//
// PASS: scenario (a) one-paragraph markdown edit yields >= 80% cache hits.
// (Scenario (b) is diagnostic — Spike A4 in Python zeroed out; pre-hash
//  normalization is the defense. It is NOT part of the PASS bar.)
//
// IMPLEMENTED. The chunker is the real G6 separator-respecting recursive splitter
// (@langchain/textsplitters' RecursiveCharacterTextSplitter — the exact algorithm
// the Spike-A 94-96% numbers were measured against in chunk_cache_v2.py, so the
// evidence transfers). No embedder is called: hit-rate is a chunk_hash MULTISET
// comparison over text, so EMBEDDER_ID/DIMENSION are an inert label on the cache
// key (identical in warm() and reindex(), they cancel out). There is therefore no
// model prerequisite — this runs offline with zero external services.

import { createHash } from "node:crypto";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

// ---- Locked params (G6) -----------------------------------------------------
const EMBEDDER_ID = "qwen3-embedding-0.6b";
const DIMENSION = 1024;
const CHARS_PER_TOKEN = 3.5; // G6 pinned char-approx ratio
const TARGET_TOKENS = 512;
const OVERLAP_PCT = 0.15;
const TARGET_CHARS = Math.round(TARGET_TOKENS * CHARS_PER_TOKEN); // ~1800
const OVERLAP_CHARS = Math.round(TARGET_CHARS * OVERLAP_PCT); // ~270
const SEPARATORS = ["\n\n", "\n", ". ", " ", ""]; // G6 recursive order
const PASS_THRESHOLD = 0.8; // >= 80% hits on a one-paragraph markdown edit

// ---- Cache key = (chunk_hash, embedder_id, dimension) -----------------------
// G6 pre-hash normalization: collapse whitespace runs, normalize line endings to
// \n, Unicode NFC. Applied ONLY to the hash input, never to stored display text.
function normalize(text: string): string {
  return text
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ") // collapse non-newline whitespace runs
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

function chunkHash(text: string): string {
  return createHash("sha256").update(normalize(text)).digest("hex").slice(0, 12);
}

function cacheKey(text: string): string {
  return `${chunkHash(text)}|${EMBEDDER_ID}|${DIMENSION}`;
}

// A durable content-addressed embedding cache (the G5 `embeddings` table, in-memory
// here). Returns whether each chunk was a HIT (vector reused) or a MISS (re-embed).
// NOTE: this is a counted MULTISET (Map<key, count>), matching the Python spike's
// decrementing multiset — NOT a plain Set. It matters: once chunk() is implemented,
// real or reflowed text can produce two IDENTICAL chunks. A Set would count both as
// hits against one cached entry and silently INFLATE the hit-rate; the multiset only
// credits as many hits as there are distinct cached copies.
class EmbeddingCache {
  private store = new Map<string, number>();
  private bump(k: string, n: number): void {
    this.store.set(k, (this.store.get(k) ?? 0) + n);
  }
  /** Mark all chunks of a corpus as embedded (warm the cache). */
  warm(chunks: string[]): void {
    for (const c of chunks) this.bump(cacheKey(c), 1);
  }
  /** Re-index `chunks`, counting hits/misses against the warm cache. */
  reindex(chunks: string[]): { hits: number; misses: number; total: number } {
    const avail = new Map(this.store); // consume warm copies as we match them
    let hits = 0;
    for (const c of chunks) {
      const k = cacheKey(c);
      const left = avail.get(k) ?? 0;
      if (left > 0) {
        hits++;
        avail.set(k, left - 1);
      } else {
        this.bump(k, 1); // a miss is embedded, then cached (content-addressed)
      }
    }
    return { hits, misses: chunks.length - hits, total: chunks.length };
  }
}

// ---- THE LOAD-BEARING MEASUREMENT -------------------------------------------
// The G6 separator-respecting recursive splitter: split on SEPARATORS in order
// (paragraph -> line -> sentence -> word -> char), pack to TARGET_CHARS with
// OVERLAP_CHARS carry-over, re-anchoring on "\n\n" first. We use langchain's
// RecursiveCharacterTextSplitter — the SAME splitter chunk_cache_v2.py used,
// configured to G6 — so this reproduces the A1 ~94% result rather than
// re-deriving it from a hand-rolled port that might diverge in merge/overlap logic.
//
// Length function: char count, with chunkSize/chunkOverlap expressed in CHARS
// (the one pinned token-length function — 3.5 chars/tok approx), so boundaries
// are reproducible and on the same char basis as the Python run.
//
// keepSeparator left at langchain's default (true), matching the Python original
// (keep_separator=True). It is immaterial on this corpus anyway: the separators
// are whitespace, which normalize() collapses before hashing — verified identical
// 94% / 18->18 either way.
//
// Contract: deterministic; returns the chunk strings in order. Async because
// langchain's splitText returns a Promise.
const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: TARGET_CHARS, // ~1800 chars ~= 512 tok at 3.5 chars/tok
  chunkOverlap: OVERLAP_CHARS, // ~270 chars (15%)
  separators: SEPARATORS, // ['\n\n','\n','. ',' ',''] — G6 recursive order
});

async function chunk(text: string): Promise<string[]> {
  return splitter.splitText(text);
}

// ---- Test corpus generators (working scaffold; deterministic) ---------------
function para(tag: string, n: number): string {
  return Array.from({ length: n }, (_, k) => `${tag}${k}`).join(" ");
}

// A realistic multi-section markdown doc. `edit` rewrites ONE paragraph in an
// early section (Section 2 of 12) — the bounded one-paragraph edit.
function markdownDoc(edit = false): string {
  const secs: string[] = [];
  for (let i = 1; i <= 12; i++) {
    const ps: string[] = [];
    for (let p = 0; p < 3; p++) {
      const n = 60 + ((i * 7 + p * 11) % 40);
      const isEdited = edit && i === 2 && p === 1;
      ps.push(isEdited ? para("EDIT", n + 15) : para(`s${i}p${p}w`, n));
    }
    secs.push(`## Section ${i}\n\n${ps.join("\n\n")}`);
  }
  return secs.join("\n\n");
}

// Simulate a PDF re-extraction with MINOR reflow: identical words, but paragraph
// breaks collapsed to single spaces (Spike A4 — the extraction-determinism risk).
function reflow(doc: string): string {
  return doc.replace(/\n{2,}/g, " ");
}

// ---- Hit-rate over a perturbation -------------------------------------------
async function measure(label: string, before: string, after: string): Promise<number> {
  const cache = new EmbeddingCache();
  const beforeChunks = await chunk(before);
  cache.warm(beforeChunks);
  const afterChunks = await chunk(after);
  const { hits, misses, total } = cache.reindex(afterChunks);
  if (total === 0) {
    console.log(`  ${label}: no chunks produced (empty input)`);
    return NaN;
  }
  const rate = hits / total;
  console.log(
    `  ${label}: ${beforeChunks.length} -> ${afterChunks.length} chunks  |  ` +
      `HITS ${hits}/${total} (${(rate * 100).toFixed(0)}%)  |  re-embeds ${misses}`,
  );
  return rate;
}

// ---- Run --------------------------------------------------------------------
console.log(
  `embedder=${EMBEDDER_ID} dim=${DIMENSION}  target=${TARGET_CHARS}ch (~${TARGET_TOKENS}tok) overlap=${OVERLAP_CHARS}ch (15%)`,
);
console.log(`PASS = >=${PASS_THRESHOLD * 100}% hits on a one-paragraph markdown edit\n`);

console.log("== (a) one-paragraph markdown edit (mid-doc, Section 2 of 12) ==");
const editRate = await measure("md edit", markdownDoc(false), markdownDoc(true));

console.log("\n== (b) PDF re-extraction reflow (same words, paragraph breaks lost) ==");
const reflowDoc = markdownDoc(false);
const reflowRate = await measure("reflow", reflowDoc, reflow(reflowDoc));

console.log("\n-- verdict --");
const pass = editRate >= PASS_THRESHOLD;
console.log(
  `(a) one-paragraph markdown edit: ${(editRate * 100).toFixed(0)}% hits -> ${pass ? "PASS" : "FAIL"} ` +
    `(bar: >=${PASS_THRESHOLD * 100}%)`,
);
console.log(
  `(b) PDF re-extraction reflow: ${(reflowRate * 100).toFixed(0)}% hits [DIAGNOSTIC, not a pass bar] -> ` +
    `${reflowRate >= PASS_THRESHOLD ? "normalization rescued the reflow" : "normalization does NOT rescue a lost \\n\\n (A4 stands)"}`,
);
process.exit(pass ? 0 : 1);
