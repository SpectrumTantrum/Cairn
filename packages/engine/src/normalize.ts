// G6/G7 — pre-hash normalization + content-addressed chunk hashing.
//
// The embedding cache is keyed on (chunk_hash, embedder, dimension); chunk_hash is the
// SHA-256 of the NORMALIZED chunk text. Normalizing before hashing means a cosmetic
// re-extraction (whitespace runs, CRLF vs LF, Unicode form) does NOT invalidate a cached
// vector — only a real content change does. Ported from spikes/chunk-cache-ts.

import { createHash } from "node:crypto";

export function normalize(text: string): string {
  return text
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ") // collapse non-newline whitespace runs
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

export function chunkHash(text: string): string {
  return createHash("sha256").update(normalize(text)).digest("hex").slice(0, 16);
}
