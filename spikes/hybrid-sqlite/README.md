# Spike: HYBRID retrieval on the locked stack (sqlite-vec + FTS5 + RRF)

> ⚠️ **VERDICT UNDER REVIEW (2026-06-14):** this spike's PASS is **plumbing-only** — it proves the pipeline runs and recovered one exact-token miss (`useEffect`). Net-positive hybrid is unproven and the semantic-pollution guard is structurally untestable in this corpus. See [`docs/spike-verdicts-correction.md`](../../docs/spike-verdicts-correction.md).

## What this proves

The Mneme engine is locked to **HYBRID ON by default** (DECIDED PARAMS G10):
dense KNN over `sqlite-vec` + keyword search over an `FTS5` external-content table
**fused app-side with Reciprocal Rank Fusion (RRF, K=60)**. The LanceDB hybrid spike
(`spikes/mneme/lancedb_hybrid.py`) proved hybrid works *in LanceDB/Python* — but that
stack was rejected (ADR-0001: TS/Node, sqlite-vec + FTS5, no server-side reranker).

This spike re-proves hybrid on the **actually-chosen** stack, in Node, with
`better-sqlite3` + `sqlite-vec` (same versions as `spikes/sqlite-vec/`), using the
**real production embedder** (Qwen3-Embedding-0.6B via Ollama `/api/embed`, 1024-dim):

1. Build one `chunks` table, a `vec_chunks` vec0 virtual table (`float[DIM]`,
   `distance_metric=cosine` per the G10 amendment, `DIM` read off the live vectors),
   and an `fts_chunks` FTS5 external-content table over the same chunk text.
2. For several test queries, run the **dense arm** (`embedding MATCH ... ORDER BY distance`)
   and the **keyword arm** (`fts_chunks MATCH ... ORDER BY rank`) separately, each over-fetching `pool=64`.
3. Fuse the two ranked id-lists with **RRF** (K=60, 1-based ranks, equal weights) in JS.
4. Compare the **hybrid top-k=8** against **dense-only top-k=8**.

### The corpus is built to actually exercise the claim

A naive corpus (one chunk per exact term) is a tautology — dense trivially ranks the
sole on-topic chunk #1, so there is nothing for FTS5 to recover. Instead, each exact
term sits inside a **cluster of same-topic chunks** that carry the *concept* but never
the *literal token* (e.g. for `useEffect`: chunks about `useState`, `useMemo`, cleanup,
dependency arrays, render lifecycle). The **gold** chunk mentions the token only in
passing (a war-story / migration-ticket framing), so dense ranks the on-concept
cluster-mates above it and **buries the gold past top-8** — exactly where only FTS5's
exact-token match can find it again. The query is the bare token, so it appears in the
**query AND the gold AND nowhere else**.

The corpus also includes:
- a **rare-identifier backstop** (`Xq7Lmn_init`) the embedder can't represent — a
  near-guaranteed FTS5 win if the well-known terms happen to stay inside dense top-8;
- **semantic / paraphrase targets** (photosynthesis, relativity, inflation) whose
  query has no lexical overlap, so dense finds them and FTS5 doesn't — these are the
  "strong semantic hits dense-only found" that hybrid must NOT evict (pollution guard).

The **FTS5 MATCH sanitizer** (G10 open-risk) tokenizes free text on non-word runs and
emits each token as a double-quoted FTS5 string OR-ed together, neutralizing every FTS5
operator (`AND OR NOT NEAR * ^ : ( ) "`). Malformed/empty input → empty arm, never throws.

## Run

```bash
cd spikes/hybrid-sqlite
npm install        # better-sqlite3 + sqlite-vec  (both MIT/Apache)
npm start          # === node hybrid.mjs
```

Needs Ollama up at `localhost:11434` with an embedder pulled. Embedder selection at runtime:
- prefers the **G10 locked default** `qwen3-embedding:0.6b` (1024-dim) → authoritative verdict;
- else falls back to `nomic-embed-text` (768-dim) and labels the verdict **PROVISIONAL**;
- override with `EMBED_MODEL=<tag>` / `OLLAMA_HOST=<url>`.

If Ollama is unreachable or no embedder is pulled, the harness prints a clean labeled
**`[skip]`** (exit 2) instead of crashing.

## PASS / FAIL

The harness computes and prints a **real** verdict (no hand-judgement, no TODO):

**PASS** (exit 0) ⟺ both hold:
- **Recovery:** for **≥1 exact-term query**, the gold chunk is **absent from dense-only
  top-8** but **present in hybrid top-8** — i.e. FTS5 + RRF rescued a chunk dense buried; AND
- **No pollution:** of the semantic golds that dense-only had in its top-8, hybrid evicts **zero**.

**FAIL** (exit 1) — hybrid never recovers an exact-term chunk dense-only missed (FTS5/RRF
buys nothing on this stack), OR RRF fusion pushes a strong semantic hit out of the top-k.

**SKIP** (exit 2) — no live embedder; no verdict produced.

A run on the fallback embedder prints `PROVISIONAL PASS/FAIL` and is **not authoritative** —
re-run with `qwen3-embedding:0.6b` to lock it in.

### Last real run (qwen3-embedding:0.6b, the locked default)

`VERDICT: PASS` — the `useEffect` query was buried by its 7 React cluster-mates
(dense-rank `-1`, outside top-8) and recovered by hybrid to rank 0; all 3 semantic golds
dense found survived RRF (0 evictions). `TLB` / `Bellman-Ford` / `Xq7Lmn_init` stayed
inside dense top-8 (no rescue needed) — well-known tokens are within the embedder's reach
even when clustered, which is why the PASS bar is "≥1 recovery", not "all".
