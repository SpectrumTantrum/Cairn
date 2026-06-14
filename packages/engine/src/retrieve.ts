// Retrieval: hybrid (dense + FTS5 keyword, fused with RRF) or keyword-only (lexical).
// FTS sanitizer + RRF fuse are verbatim from spikes/hybrid-sqlite (G10).
//
// `auto` mode uses hybrid when the index has vectors AND Ollama is reachable, otherwise
// degrades to keyword-only — so the CLI is usable with zero model setup and gets better
// (dense recall) for free when a local embedder is present.

import { embed, ollamaUp } from "./embed.ts";
import type { Store } from "./store.ts";

const K_RRF = 60; // G10 RRF constant

export function sanitizeForFts(raw: string): string {
  const tokens = (raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(Boolean);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

export function rrfFuse(arms: number[][]): { id: number; score: number }[] {
  const score = new Map<number, number>();
  for (const ranked of arms) {
    ranked.forEach((id, idx) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (K_RRF + idx + 1)); // 1-based ranks
    });
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id, s]) => ({ id, score: s }));
}

export interface SearchHit {
  file: string;
  heading: string;
  line: number;
  score: number; // RRF score in hybrid mode; NaN in lexical mode (ranked by BM25)
  snippet: string; // truncated, for display
  text: string; // full chunk text, for grounding (ask)
  arms: string; // "dense+fts" | "dense" | "fts"
}

export type Mode = "auto" | "hybrid" | "lexical";

export interface SearchOpts {
  k?: number;
  pool?: number;
  mode?: Mode;
  embedder?: string;
}

export async function search(
  store: Store,
  query: string,
  opts: SearchOpts = {},
): Promise<{ hits: SearchHit[]; mode: "hybrid" | "lexical" }> {
  const k = opts.k ?? 8;
  const pool = opts.pool ?? 64;
  const wantHybrid = (opts.mode ?? "auto") !== "lexical";
  const canHybrid = wantHybrid && store.hasVectors() && (await ollamaUp());

  const ftsIds = store.ftsArm(sanitizeForFts(query), pool).map((h) => h.id);

  if (!canHybrid) {
    const hits = ftsIds.slice(0, k).map((id) => toHit(store, id, NaN, false, true));
    return { hits, mode: "lexical" };
  }

  const embedder = opts.embedder ?? store.getMeta("embedder") ?? "";
  const [qvec] = await embed(embedder, [query]);
  const qbuf = Buffer.from(Float32Array.from(qvec).buffer);
  const denseIds = store.denseArm(qbuf, pool);
  const fused = rrfFuse([denseIds, ftsIds]).slice(0, k);
  const denseSet = new Set(denseIds);
  const ftsSet = new Set(ftsIds);
  const hits = fused.map(({ id, score }) => toHit(store, id, score, denseSet.has(id), ftsSet.has(id)));
  return { hits, mode: "hybrid" };
}

function toHit(store: Store, id: number, score: number, inDense: boolean, inFts: boolean): SearchHit {
  const c = store.getChunk(id);
  const arms = inDense && inFts ? "dense+fts" : inDense ? "dense" : "fts";
  return {
    file: c?.file ?? "?",
    heading: c?.heading ?? "",
    line: c?.line ?? 0,
    score,
    snippet: snippetOf(c?.text ?? ""),
    text: c?.text ?? "",
    arms,
  };
}

function snippetOf(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 200 ? clean.slice(0, 200) + "…" : clean;
}
