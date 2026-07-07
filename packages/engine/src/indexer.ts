// Re-index pipeline: discover → chunk → embed (cache-aware) → persist.
// indexVault composes these steps; each is testable in isolation.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { openIndex, type Index } from "./vault-index.js";
import { chunkMarkdown } from "./chunk.js";
import type { Chunk } from "./chunk.js";
import { chunkHash } from "./normalize.js";
import { resolveEmbedder, embed } from "./embed.js";

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
}

export interface EmbedChunksResult {
  vectors: (Buffer | null)[];
  embedder?: string;
  dim?: number;
  embedded: number;
  cached: number;
}

export function discoverMarkdownFiles(root: string): string[] {
  const out: string[] = [];
  const rec = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) rec(full);
      else if (/\.(md|markdown)$/i.test(name)) out.push(full);
    }
  };
  rec(root);
  return out;
}

export async function chunkVaultFiles(root: string, files: string[]): Promise<PendingChunk[]> {
  const pending: PendingChunk[] = [];
  for (const abs of files) {
    const rel = relative(root, abs).split(sep).join("/");
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

  if (!lexical && pending.length > 0) {
    embedder = await resolveEmbedder(opts.embedder);
    dim = (await embed(embedder, ["cairn dimension probe"]))[0].length;

    const missIdx: number[] = [];
    pending.forEach((p, i) => {
      const hit = index.getCachedVec(p.hash, embedder as string, dim as number);
      if (hit) {
        vectors[i] = hit;
        cached++;
      } else {
        missIdx.push(i);
      }
    });

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
      vector: lexical ? undefined : vectors[i],
    })),
  });
}

export async function indexVault(
  root: string,
  opts: { lexical?: boolean; embedder?: string } = {},
): Promise<IndexStats> {
  const files = discoverMarkdownFiles(root);
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
