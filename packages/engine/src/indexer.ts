// Index a folder of Markdown: walk -> chunk (with provenance) -> embed (cache-aware)
// -> store. A full rebuild each run, but the content-addressed embedding cache means an
// edit only re-embeds the chunks that actually changed (the chunk-cache-ts result).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { openIndex } from "./vault-index.js";
import { chunkMarkdown } from "./chunk.js";
import type { Chunk } from "./chunk.js";
import { chunkHash } from "./normalize.js";
import { resolveEmbedder, embed } from "./embed.js";

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
  const index = openIndex(root);

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

  index.rebuildIndex({
    mode: lexical ? "lexical" : "hybrid",
    embedder,
    dim,
    files: files.length,
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

  index.close();
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
