// Re-index pipeline: discover → chunk → embed (cache-aware) → persist.
// indexVault composes these steps; each is testable in isolation.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { openIndex, type Index } from "./vault-index.js";
import { chunkMarkdown } from "./chunk.js";
import type { Chunk } from "./chunk.js";
import { chunkHash } from "./normalize.js";
import { resolveEmbedder, embed } from "./embed.js";
import { extractPdfPages, pdfPageHeading } from "./pdf-text.js";
import { extractDocxText } from "./docx-text.js";
import { extractHtmlText } from "./html-text.js";
import { isAudioPath } from "./audio-files.js";
import { isImagePath } from "./image-files.js";
import { isVideoPath } from "./video-files.js";
import { decodeUtf8Text } from "./utf8-text.js";

const SKIP_DIRS = new Set([".cairn", ".git", "node_modules", ".obsidian"]);

export interface IndexStats {
  mode: "hybrid" | "lexical";
  files: number;
  chunks: number;
  embedded: number;
  cached: number;
  embedder?: string;
  dim?: number;
}

export interface PendingChunk {
  file: string;
  chunk: Chunk;
  hash: string;
  /** 1-based PDF page. Absent for Markdown and plain text. PDF chunks are not embedded. */
  page?: number;
}

/**
 * PDF text is keyword-only in this slice. Markdown, plain text, HTML, tables, and Word
 * .docx body text are embedded. Image files never become chunks, so they are not embedded.
 */
export function chunkNeedsEmbedding(chunk: PendingChunk): boolean {
  return chunk.page == null;
}

export interface EmbedChunksResult {
  vectors: (Buffer | null)[];
  embedder?: string;
  dim?: number;
  embedded: number;
  cached: number;
}

function discoverFiles(root: string, pattern: RegExp): string[] {
  const out: string[] = [];
  const rec = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) rec(full);
      else if (pattern.test(name)) out.push(full);
    }
  };
  rec(root);
  return out;
}

export function discoverMarkdownFiles(root: string): string[] {
  return discoverFiles(root, /\.(md|markdown)$/i);
}

const INDEXABLE_EXT = /\.(md|markdown|txt|csv|tsv|html|htm|docx|pdf|png|jpe?g|webp|gif|mp3|wav|m4a|mp4|webm|mov)$/i;

function isHtmlPath(path: string): boolean {
  return /\.html?$/i.test(path);
}

function isPlainTextPath(path: string): boolean {
  return path.toLowerCase().endsWith(".txt");
}

function isTablePath(path: string): boolean {
  return /\.(csv|tsv)$/i.test(path);
}

/**
 * Markdown, plain UTF-8 text, CSV, TSV, HTML, Word .docx, PDF, images, audio (mp3, wav, m4a),
 * and video (mp4, webm, mov). .doc, .docm, and .dotx stay out.
 * Images, audio, and video are path-only: no text body.
 */
export function isIndexableVaultPath(path: string): boolean {
  return INDEXABLE_EXT.test(path);
}

function readUtf8TextFile(abs: string): string | null {
  try {
    return decodeUtf8Text(readFileSync(abs));
  } catch {
    return null;
  }
}

/**
 * Markdown notes, UTF-8 `.txt`, UTF-8 `.csv` / `.tsv`, UTF-8 `.html` / `.htm`, Word `.docx`, PDF, images, audio, and video.
 * A text, table, or HTML file that is not valid UTF-8 is skipped.
 * Images, audio, and video are included by extension only. Other containers stay out.
 */
export function discoverIndexableFiles(root: string): string[] {
  return discoverFiles(root, INDEXABLE_EXT).filter((abs) => {
    if (!isPlainTextPath(abs) && !isTablePath(abs) && !isHtmlPath(abs)) return true;
    return readUtf8TextFile(abs) !== null;
  });
}

async function chunkPdfFile(rel: string, abs: string): Promise<PendingChunk[]> {
  let pages;
  try {
    pages = await extractPdfPages(abs);
  } catch {
    // Unreadable or password-protected: index nothing from this file.
    return [];
  }
  const pending: PendingChunk[] = [];
  let ordinal = 0;
  for (const page of pages) {
    const heading = pdfPageHeading(page.text);
    const chunks = await chunkMarkdown(page.text);
    for (const ch of chunks) {
      pending.push({
        file: rel,
        chunk: { ...ch, ordinal: ordinal++, heading: ch.heading || heading },
        hash: chunkHash(ch.text),
        page: page.page,
      });
    }
  }
  return pending;
}

async function chunkDocxFile(rel: string, abs: string): Promise<PendingChunk[]> {
  try {
    const text = extractDocxText(abs);
    if (!text.trim()) return [];
    const chunks = await chunkMarkdown(text);
    return chunks.map((ch) => ({ file: rel, chunk: ch, hash: chunkHash(ch.text) }));
  } catch {
    // Password-protected, damaged, or empty: index nothing from this file.
    return [];
  }
}

export async function chunkVaultFiles(root: string, files: string[]): Promise<PendingChunk[]> {
  const pending: PendingChunk[] = [];
  for (const abs of files) {
    const rel = relative(root, abs).split(sep).join("/");
    // Path and filename only. No OCR, no transcript, no text body, no embedding.
    if (isImagePath(rel) || isAudioPath(rel) || isVideoPath(rel)) continue;
    if (/\.pdf$/i.test(rel)) {
      pending.push(...(await chunkPdfFile(rel, abs)));
      continue;
    }
    if (/\.docx$/i.test(rel)) {
      pending.push(...(await chunkDocxFile(rel, abs)));
      continue;
    }
    if (/\.txt$/i.test(rel) || isTablePath(rel)) {
      const text = readUtf8TextFile(abs);
      // Invalid UTF-8 and blank files contribute no chunks. A table keeps its header row.
      if (!text?.trim()) continue;
      const chunks = await chunkMarkdown(text);
      for (const ch of chunks) pending.push({ file: rel, chunk: ch, hash: chunkHash(ch.text) });
      continue;
    }
    if (isHtmlPath(rel)) {
      const raw = readUtf8TextFile(abs);
      if (!raw) continue;
      const text = extractHtmlText(raw);
      // Scripts, styles, and empty documents contribute no chunks.
      if (!text.trim()) continue;
      const chunks = await chunkMarkdown(text);
      for (const ch of chunks) pending.push({ file: rel, chunk: ch, hash: chunkHash(ch.text) });
      continue;
    }
    const text = readFileSync(abs, "utf8");
    const chunks = await chunkMarkdown(text);
    for (const ch of chunks) pending.push({ file: rel, chunk: ch, hash: chunkHash(ch.text) });
  }
  return pending;
}

export async function embedPendingChunks(
  index: Index,
  pending: PendingChunk[],
  opts: { lexical?: boolean; embedder?: string } = {},
): Promise<EmbedChunksResult> {
  const lexical = !!opts.lexical;
  const vectors: (Buffer | null)[] = pending.map(() => null);
  let embedder: string | undefined;
  let dim: number | undefined;
  let embedded = 0;
  let cached = 0;

  const embedIdx = pending.map((p, i) => i).filter((i) => chunkNeedsEmbedding(pending[i]));
  if (!lexical && embedIdx.length > 0) {
    embedder = await resolveEmbedder(opts.embedder);
    dim = (await embed(embedder, ["cairn dimension probe"]))[0].length;

    const missIdx: number[] = [];
    for (const i of embedIdx) {
      const hit = index.getCachedVec(pending[i].hash, embedder as string, dim as number);
      if (hit) {
        vectors[i] = hit;
        cached++;
      } else {
        missIdx.push(i);
      }
    }

    const BATCH = 64;
    for (let b = 0; b < missIdx.length; b += BATCH) {
      const slice = missIdx.slice(b, b + BATCH);
      const vecs = await embed(embedder, slice.map((i) => pending[i].chunk.text));
      slice.forEach((i, j) => {
        const buf = Buffer.from(Float32Array.from(vecs[j]).buffer);
        vectors[i] = buf;
        index.putCachedVec(pending[i].hash, embedder as string, dim as number, buf);
        embedded++;
      });
    }
  }

  return { vectors, embedder, dim, embedded, cached };
}

export function persistVaultIndex(
  index: Index,
  pending: PendingChunk[],
  vectors: (Buffer | null)[],
  opts: {
    lexical: boolean;
    embedder?: string;
    dim?: number;
    files: number;
  },
): void {
  const lexical = opts.lexical;
  index.rebuildIndex({
    mode: lexical ? "lexical" : "hybrid",
    embedder: opts.embedder,
    dim: opts.dim,
    files: opts.files,
    chunks: pending.map((p, i) => ({
      id: i + 1,
      file: p.file,
      ordinal: p.chunk.ordinal,
      line: p.chunk.line,
      heading: p.chunk.heading,
      text: p.chunk.text,
      hash: p.hash,
      page: p.page,
      vector: lexical ? undefined : vectors[i],
    })),
  });
}

export async function indexVault(
  root: string,
  opts: { lexical?: boolean; embedder?: string } = {},
): Promise<IndexStats> {
  const files = discoverIndexableFiles(root);
  const index = openIndex(root);
  const pending = await chunkVaultFiles(root, files);
  const embedResult = await embedPendingChunks(index, pending, opts);
  persistVaultIndex(index, pending, embedResult.vectors, {
    lexical: !!opts.lexical,
    embedder: embedResult.embedder,
    dim: embedResult.dim,
    files: files.length,
  });
  index.close();

  return {
    mode: opts.lexical ? "lexical" : "hybrid",
    files: files.length,
    chunks: pending.length,
    embedded: embedResult.embedded,
    cached: embedResult.cached,
    embedder: embedResult.embedder,
    dim: embedResult.dim,
  };
}
