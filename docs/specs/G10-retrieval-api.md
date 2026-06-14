# G10 — `search_notes` retrieval API (filter schema, RRF fusion, "not covered" gate, ungrounded toggle)

Status: decided 2026-06-14. Implements ADR-0001 (headless TS engine), the locked HYBRID-ON default, and PRD §6 (`search_notes(query, k=8, filter?)`, Ask "not covered" + ungrounded toggle). Builds on the G5 schema and G8 anchors. Empirically verified against `spikes/sqlite-vec` (sqlite-vec v0.1.9, better-sqlite3).

## 1. Signature & return type (engine — pure data, no DOM/Electron)

```ts
type NodeType = 'note' | 'pdf' | 'flashcard' | 'annotation';
type Retriever = 'dense' | 'fts';

interface SearchFilter {
  /** vault-relative POSIX folder prefixes; OR within the list. v1 implemented. */
  folders?: string[];
  /** chunk source_type values; OR within the list. v1 implemented. */
  types?: NodeType[];
  /** DEFERRED to v1.1 (no tag column in G5 chunks yet). Accepted in the type, ignored at runtime in v1. */
  tags?: string[];
}

interface SearchOptions {
  k?: number;            // returned count, default 8
  filter?: SearchFilter;
  candidatePool?: number; // per-arm over-fetch, default 64 (see §3)
}

/** Citation anchor (G8 shapes), discriminated by node provenance. */
type CitationAnchor =
  | { kind: 'markdown'; node: string; heading_slug: string | null;
      char_offset: number | null;
      context: { prefix: string; quote: string; suffix: string } }
  | { kind: 'pdf'; pdf_content_hash: string; page: number;
      char_start: number | null; char_end: number | null; quote: string };

interface RetrievedChunk {
  // --- identity / G5 chunk fields ---
  chunk_id: number;
  file: string;            // vault-relative path
  source_type: NodeType;
  chunk_index: number;
  text: string;            // chunk display text
  heading_path: string | null;
  page: number | null;
  char_start: number | null;
  char_end: number | null;
  ocr: boolean;
  block_type: string | null;
  anchor: CitationAnchor;  // ready-to-jump citation (G8)

  // --- scoring (THREE distinct signals; never conflate) ---
  cosine: number;          // raw cosine SIMILARITY in [-1,1] vs query. Gate + display. ALWAYS present.
  rrf_score: number;       // fused rank score. ORDERING ONLY (carries no magnitude). See §2.
  retrievers: Retriever[]; // which arm(s) hit this chunk: ['dense'] | ['fts'] | ['dense','fts']
}

interface SearchResult {
  query: string;
  k: number;
  /** Coverage gate result (§4). Computed on the filtered candidate POOL, before RRF trim. */
  covered: boolean;
  /** max cosine over the filtered candidate pool — the value the gate compared to the threshold. */
  pool_max_cosine: number; // -Infinity (or 0 by convention) when pool empty
  /** absolute cosine floor the gate used (default 0.5; tunable — see §4). */
  coverage_threshold: number;
  /** top-k after RRF fusion + trim, descending rrf_score. */
  chunks: RetrievedChunk[];
}

/**
 * Hybrid retrieval over the active index. Pure data: returns chunks + cosine + rrf_score
 * + which retriever(s) hit + a coverage verdict. Does NOT decide UI behavior (the
 * ungrounded toggle is the Ask layer, §5). Stays headless per ADR-0001 line 13.
 */
declare function search_notes(query: string, opts?: SearchOptions): Promise<SearchResult>;
```

## 2. RRF fusion (the merge applied before the trim — and what it is NOT)

Reciprocal Rank Fusion over the two ranked candidate lists:

```
rrf_score(chunk) = Σ_arm  weight_arm / (K_RRF + rank_arm(chunk))
```

- `K_RRF = 60` (canonical constant). `rank_arm` is **1-based** within that arm's candidate list (best = 1).
- Equal arm weights: `weight_dense = weight_fts = 1.0`.
- A chunk contributes a term **only for arms that actually returned it**; a single-arm hit gets one term, a both-arm hit gets two (which is why both-arm hits systematically outrank single-arm hits — see §4 for why this means the gate must NOT read off `rrf_score` or the trimmed list).
- RRF uses **ranks only** and deliberately discards score magnitude. Therefore `rrf_score` carries **no cosine information** and MUST NOT be used for the coverage gate or any similarity display. Cosine is carried as its own field for exactly this reason.

## 3. Pipeline (order is load-bearing)

Two distinct `k`s: a per-arm **candidate pool** for fusion quality, and the **returned k=8**.

1. **Embed** the query once → `qvec` (Qwen3-Embedding-0.6B, 1024-dim, unit space; matches the index embedder/dim in `meta`).
2. **Dense arm** — `SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH :qvec ORDER BY distance LIMIT :pool` (pool default 64). With `distance_metric=cosine` (see §6) `cosine = 1 - distance` for every dense hit, free.
3. **FTS arm** — `SELECT rowid AS chunk_id, rank FROM fts_chunks WHERE fts_chunks MATCH :q ORDER BY rank LIMIT :pool`. (Sanitize the user query into an FTS5 MATCH expression; on a malformed/empty MATCH, treat the FTS arm as empty rather than throwing.)
4. **Join + filter** — union the candidate `chunk_id`s, join to `chunks` to hydrate G5 fields + build G8 anchors, and apply `filter` (`folders` as path-prefix OR; `types` as `source_type IN (...)`). vec0 v0.1.9 has no clean pre-filtered KNN, so filtering is **post-KNN** (over-fetch then filter). `tags` is accepted but ignored in v1.
5. **Cosine for every survivor** — dense hits already carry cosine (step 2). For **FTS-only** survivors (no dense distance), compute it on demand: `vec_distance_cosine(:qvec, e.vector)` joined to the `embeddings` cache / `vec_chunks` (verified working in the spike). Now every candidate has a cosine.
6. **Coverage gate (§4)** — compute `pool_max_cosine = max(cosine)` over the **filtered candidate pool from step 5** (NOT the trimmed result). `covered = pool_max_cosine >= coverage_threshold`.
7. **RRF fuse (§2)** over the filtered pool, sort by `rrf_score` desc, **trim to k=8**. Set `retrievers` per chunk. Return.

Why the gate sits at step 6 (before trim) and not on the returned 8: RRF favors both-arm hits, so the single highest-cosine chunk (often dense-only) can be pushed past rank 8 during the trim. A gate that read only the returned 8 would report "not covered" while the closest note in the vault sat at e.g. cosine 0.7 — a false negative exactly on the queries where coverage matters. The pool-max gate is computed over every filtered candidate, so it cannot be fooled by the trim.

## 4. "Not covered" coverage gate

- `coverage_threshold` default **0.5**, an **absolute** cosine floor (NOT batch/min-max normalized — min-max would always put a 1.0 in any non-empty batch and the gate would never fire). It is a **tunable**: calibrate on the same 50-Q Qwen3-Embedding-0.6B self-test corpus that the v1-scope build-prereq uses (≥80% top-3). The 0.5 default is documented-but-unvalidated for this embedder until that spike runs.
- `covered = pool_max_cosine >= coverage_threshold`, evaluated over the **filtered** pool — i.e. "do your notes *in this scope* cover this," respecting `folders`/`types`.
- Empty index, empty/whitespace query, or both arms empty → empty pool → `pool_max_cosine` sentinel below threshold → `covered = false`, `chunks = []`. Clean, no throw.
- The engine only computes `covered`. What to *do* about it is the Ask layer (§5).

## 5. Ask-mode orchestration (UI layer — consumes `covered`, not part of the engine signature)

Per PRD §6 (Ask) and ADR-0005 (Ask = grounded Q&A, cites every claim). The engine returns data; Ask decides presentation:

- `covered === true` → Ask answers grounded, citing every claim from `chunks` (with G8 jump-to-source anchors).
- `covered === false` → Ask says **"your notes don't cover this"** and does NOT answer from general knowledge by default.
- **Ungrounded toggle:** an **explicit per-message** control offering an ungrounded (general-knowledge) answer. When the user opts in, the ungrounded answer renders in a **visually-distinct container** (clearly marked "not from your notes / ungrounded"). The opt-in is **sticky per session** (remembered for the session, reset on new session), never persisted as a silent default.
- This whole block is Ask-layer UI/orchestration; it is intentionally **not** baked into `search_notes` so the engine stays headless (ADR-0001 line 13).

## 6. Amendment to G5/G7 — vec0 must use cosine distance (so the gate reads cosine directly)

The G5 DDL and the original spike are **L2** (`metric=L2(default)`). The coverage gate needs **cosine**. Amend the G5 vec0 DDL to:

```sql
CREATE VIRTUAL TABLE vec_chunks USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding float[1024] distance_metric=cosine   -- DIM templated from meta.dimension
);
```

Verified in sqlite-vec v0.1.9: with `distance_metric=cosine`, the KNN `distance` column equals `1 - cosine_similarity`, so `cosine = 1 - distance` per dense hit at zero extra cost; ranking is unchanged from L2 on unit-normalized vectors. The scalar `vec_distance_cosine(a, b)` is also available for the FTS-only on-demand cosine (step 5). This touches the stored-vector contract only at the vec0 layer (the durable `embeddings` cache bytes are unchanged float32); it is a one-token DDL amendment, not a re-embed.

## Open risks
- `coverage_threshold = 0.5` is unvalidated for Qwen3-Embedding-0.6B; calibrate on the 50-Q self-test before locking. Tune as one absolute float in `meta`.
- Selective filter underflow: pool=64 then post-filter to a tiny folder can leave `< k` survivors. Acceptable for v1 (vec0 v0.1.9 has no pre-filtered KNN); larger vaults may need a larger pool or iterative widening.
- FTS5 MATCH-expression sanitization from free-text user queries must be robust (quotes, operators) — malformed input degrades the FTS arm to empty, never throws.
- `tags` filtering is type-visible but a no-op in v1; ensure callers don't assume it filters.
