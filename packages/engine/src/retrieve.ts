// Retrieval: hybrid (dense + FTS5 keyword, fused with RRF) or keyword-only (lexical).
// FTS sanitizer + RRF fuse are verbatim from spikes/hybrid-sqlite (G10).
//
// `auto` mode uses hybrid when the index has vectors AND Ollama is reachable, otherwise
// degrades to keyword-only — so the CLI is usable with zero model setup and gets better
// (dense recall) for free when a local embedder is present.

import { embed, formatQueryForEmbedding } from "./embed.js";
import { getModelProvider } from "./model-provider.js";
import type { Index } from "./vault-index.js";

const K_RRF = 60; // G10 RRF constant
export const DEFAULT_COVERAGE_THRESHOLD = 0.5;

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
  cosine: number; // raw cosine similarity when hybrid can compute it; NaN in lexical mode
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
  coverageThreshold?: number;
}

export interface SearchCoverage {
  covered: boolean;
  poolMaxCosine: number;
  threshold: number;
}

export async function search(
  index: Index,
  query: string,
  opts: SearchOpts = {},
): Promise<{ hits: SearchHit[]; mode: "hybrid" | "lexical"; coverage: SearchCoverage }> {
  const k = opts.k ?? 8;
  const pool = opts.pool ?? 64;
  const threshold = opts.coverageThreshold ?? DEFAULT_COVERAGE_THRESHOLD;
  const wantHybrid = (opts.mode ?? "auto") !== "lexical";
  const canHybrid = wantHybrid && index.hasVectors() && (await getModelProvider().isReachable());

  const ftsIds = index.ftsArm(sanitizeForFts(query), pool).map((h) => h.id);

  if (!canHybrid) {
    const hits = ftsIds.slice(0, k).map((id) => toHit(index, id, NaN, NaN, false, true));
    return {
      hits,
      mode: "lexical",
      coverage: {
        covered: hits.length > 0,
        poolMaxCosine: Number.NaN,
        threshold,
      },
    };
  }

  const embedder = opts.embedder ?? index.getMeta("embedder") ?? "";
  const [qvec] = await embed(embedder, [formatQueryForEmbedding(embedder, query)]);
  const qbuf = Buffer.from(Float32Array.from(qvec).buffer);
  const denseRows = index.denseArm(qbuf, pool);
  const denseIds = denseRows.map((h) => h.id);
  const denseCosines = new Map(denseRows.map((h) => [h.id, h.cosine]));
  const poolMaxCosine = denseRows.length > 0 ? Math.max(...denseRows.map((h) => h.cosine)) : Number.NEGATIVE_INFINITY;
  const fused = rrfFuse([denseIds, ftsIds]).slice(0, k);
  const denseSet = new Set(denseIds);
  const ftsSet = new Set(ftsIds);
  const hits = fused.map(({ id, score }) =>
    toHit(index, id, score, denseCosines.get(id) ?? NaN, denseSet.has(id), ftsSet.has(id)),
  );
  return {
    hits,
    mode: "hybrid",
    coverage: {
      covered: poolMaxCosine >= threshold,
      poolMaxCosine,
      threshold,
    },
  };
}

function toHit(index: Index, id: number, score: number, cosine: number, inDense: boolean, inFts: boolean): SearchHit {
  const c = index.getChunk(id);
  const arms = inDense && inFts ? "dense+fts" : inDense ? "dense" : "fts";
  return {
    file: c?.file ?? "?",
    heading: c?.heading ?? "",
    line: c?.line ?? 0,
    score,
    cosine,
    snippet: snippetOf(c?.text ?? ""),
    text: c?.text ?? "",
    arms,
  };
}

function snippetOf(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 200 ? clean.slice(0, 200) + "…" : clean;
}
