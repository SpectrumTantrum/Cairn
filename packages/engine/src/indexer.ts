// Index a folder of Markdown: walk -> chunk (with provenance) -> embed (cache-aware)
// -> store. A full rebuild each run, but the content-addressed embedding cache means an
// edit only re-embeds the chunks that actually changed (the chunk-cache-ts result).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Store } from "./store.ts";
import { chunkMarkdown } from "./chunk.ts";
import type { Chunk } from "./chunk.ts";
import { chunkHash } from "./normalize.ts";
import { resolveEmbedder, embed } from "./embed.ts";

const SKIP_DIRS = new Set([".cairn", ".git", "node_modules", ".obsidian"]);

function walkMarkdown(root: string): string[] {
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

export interface IndexStats {
  mode: "hybrid" | "lexical";
  files: number;
  chunks: number;
  embedded: number; // freshly embedded (cache misses)
  cached: number; // reused from the embedding cache (hits)
  embedder?: string;
  dim?: number;
}

interface Pending {
  file: string;
  chunk: Chunk;
  hash: string;
}

export async function indexVault(
  root: string,
  opts: { lexical?: boolean; embedder?: string } = {},
): Promise<IndexStats> {
  const files = walkMarkdown(root);
  const store = new Store(root);

  // 1) Chunk every file (with provenance).
  const pending: Pending[] = [];
  for (const abs of files) {
    const rel = relative(root, abs).split(sep).join("/");
    const text = readFileSync(abs, "utf8");
    const chunks = await chunkMarkdown(text);
    for (const ch of chunks) pending.push({ file: rel, chunk: ch, hash: chunkHash(ch.text) });
  }

  const lexical = !!opts.lexical;
  const vectors: (Buffer | null)[] = pending.map(() => null);
  let embedder: string | undefined;
  let dim: number | undefined;
  let embedded = 0;
  let cached = 0;

  // 2) Embed (hybrid only), reusing cached vectors where the chunk hash is unchanged.
  if (!lexical && pending.length > 0) {
    embedder = await resolveEmbedder(opts.embedder);
    dim = (await embed(embedder, ["cairn dimension probe"]))[0].length;

    const missIdx: number[] = [];
    pending.forEach((p, i) => {
      const hit = store.getCachedVec(p.hash, embedder as string, dim as number);
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
        store.putCachedVec(pending[i].hash, embedder as string, dim as number, buf);
        embedded++;
      });
    }
  }

  // 3) Rebuild the index in one transaction.
  store.transaction(() => {
    store.clearChunks();
    if (!lexical && dim) store.resetVectors(dim);
    pending.forEach((p, i) => {
      const id = i + 1;
      store.insertChunk(id, p.file, p.chunk.ordinal, p.chunk.line, p.chunk.heading, p.chunk.text, p.hash);
      const v = vectors[i];
      if (!lexical && v) store.insertVec(id, v);
    });
    store.setMeta("mode", lexical ? "lexical" : "hybrid");
    if (embedder) store.setMeta("embedder", embedder);
    if (dim) store.setMeta("dim", String(dim));
    store.setMeta("files", String(files.length));
    store.setMeta("chunks", String(pending.length));
  });

  store.close();
  return {
    mode: lexical ? "lexical" : "hybrid",
    files: files.length,
    chunks: pending.length,
    embedded,
    cached,
    embedder,
    dim,
  };
}
