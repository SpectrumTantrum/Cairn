# Cairn — Engineering Decisions (v1)

**Created:** 2026-06-14. Companion to [`v1-scope.md`](v1-scope.md) (the *what*) — this is the *how*: the concrete engineering defaults for the build-time decisions G5–G14, recommended and ready to implement against. Produced by a multi-agent pass over the locked decisions; each is a sane default, not gospel — revise if a spike contradicts it.

These implement the locked architecture: TS in-process engine (ADR-0001), tiered models (ADR-0002), heterogeneous plain-files graph (ADR-0003), tiered PDF extraction (ADR-0004), KM identity (ADR-0005). Three of these decisions were load-bearing enough to also get their own ADR (chunking → ADR-0006, citation anchors → ADR-0007, write-safety → ADR-0008); the rest live here.

| Gap | Decision | Home |
|---|---|---|
| G5 | `.cairn/index.db` schema | this doc |
| G6 | chunking 512/15% structure-aware | ADR-0006 + this doc |
| G7 | per-chunk embedding cache (TS) | this doc |
| G8 | citation anchors (fuzzy md / page-level PDF) | ADR-0007 + this doc |
| G10 | `search_notes` API + coverage gate | this doc |
| G12 | model-manifest schema | this doc (snapshot values in `model-strategy.md`) |
| G13 | first-run hardware detection | this doc |
| G14 | agent write-safety + run revert | ADR-0008 + this doc |


---

## G5 — .cairn/index.db schema (files / chunks / vec0 / FTS5 / embeddings cache / meta)

**Decision.** A single SQLite file at <vault>/.cairn/index.db holds six objects: files (snapshot for change detection), chunks (text + citation metadata, including chunk_hash), a durable embeddings cache keyed (chunk_hash, embedder_id, dimension), a sqlite-vec vec0 virtual table as the live query accelerator for the active embedder (populated from the cache, keyed by chunk_id), an FTS5 external-content table over chunks.text, and a key-value meta table. The index is disposable, per-machine, never synced; the vault is the source of truth.

## `.cairn/index.db` — DDL (SQLite, via better-sqlite3 + sqlite-vec; both confirmed working in `spikes/sqlite-vec/perf.js`)

Load order at open: `sqliteVec.load(db)`, then `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`.

```sql
-- 1) FILES — flat change-detection snapshot (ADR-0001 / engine feasibility report: flat {path:(hash,mtime,size)}, not a Merkle tree)
CREATE TABLE files (
  path  TEXT PRIMARY KEY,          -- vault-relative POSIX path
  hash  TEXT NOT NULL,            -- SHA-256 of file bytes (extraction/chunking cache key)
  mtime INTEGER NOT NULL,         -- epoch ms; Git-index-style mtime gating before hashing
  size  INTEGER NOT NULL          -- bytes
);

-- 2) CHUNKS — text + citation metadata. source_type is chunk PROVENANCE, not a node type
--    (node types are locked to note|pdf|flashcard by ADR-0003; 'annotation' chunks derive
--     from a pdf node's vault sidecar — see G8).
CREATE TABLE chunks (
  id            INTEGER PRIMARY KEY,          -- rowid; this is the vec0 / FTS5 key
  file          TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  chunk_index   INTEGER NOT NULL,            -- ordinal within file
  text          TEXT NOT NULL,               -- chunk text (also FTS-indexed; see note on external content)
  chunk_hash    TEXT NOT NULL,               -- SHA-256 of NORMALIZED text (embedding-cache key; G7)
  source_type   TEXT NOT NULL CHECK(source_type IN ('note','pdf','flashcard','annotation')),
  heading_path  TEXT,                        -- nullable; '>'-joined heading slugs (markdown); used by G8 markdown anchor
  page          INTEGER,                     -- nullable; 1-based PDF page (pdf/annotation only)
  char_start    INTEGER,                     -- nullable; offset into the page's/section's pinned extracted text
  char_end      INTEGER,                     -- nullable
  ocr           INTEGER NOT NULL DEFAULT 0,  -- 0/1; true if text came from Tesseract/vision (ADR-0004)
  block_type    TEXT,                        -- nullable; structural label (heading|paragraph|list|table|...)
  created       INTEGER NOT NULL,            -- epoch ms when this chunk row was written
  UNIQUE(file, chunk_index)
);
CREATE INDEX idx_chunks_file ON chunks(file);
CREATE INDEX idx_chunks_hash ON chunks(chunk_hash);

-- 3) EMBEDDINGS — durable content-addressed cache (the SOURCE OF TRUTH for vectors).
--    Survives embedder switches; switching BACK reuses cached vectors for free.
CREATE TABLE embeddings (
  chunk_hash  TEXT NOT NULL,
  embedder_id TEXT NOT NULL,   -- e.g. 'qwen3-embedding-0.6b'
  dimension   INTEGER NOT NULL,
  vector      BLOB NOT NULL,   -- float32 little-endian, length = dimension*4
  created     INTEGER NOT NULL,
  PRIMARY KEY (chunk_hash, embedder_id, dimension)
);

-- 4) VEC0 — live KNN accelerator for the ACTIVE (embedder_id,dimension). Keyed by chunk_id.
--    Brute-force linear KNN, fine at v1 scale (spike: ~18ms/50k @ k=8). DERIVED: rebuilt from
--    `embeddings` cache on open if embedder/dim match; dim is baked into the table and cannot be
--    altered in place — a dimension change DROPs+recreates this table.
CREATE VIRTUAL TABLE vec_chunks USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding float[1024]            -- Qwen3-Embedding-0.6B default; DIM is templated from meta.dimension
);

-- 5) FTS5 — keyword half of hybrid (HYBRID ON by default). External-content over chunks to
--    avoid double-storing text; chunks.id is the rowid.
CREATE VIRTUAL TABLE fts_chunks USING fts5(
  text,
  content='chunks',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

-- 6) META — key/value, extensible.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Required keys at init:
--   schema_version    = '1'
--   embedder_id       = 'qwen3-embedding-0.6b'
--   dimension         = '1024'
--   chunk_config_hash = '<hash from G6>'
```

### Write discipline (virtual tables do NOT cascade)
The FK `chunks.file -> files.path ON DELETE CASCADE` cleans `chunks` only. `vec_chunks` and `fts_chunks` are NOT touched by the cascade. Because TS owns every write (ADR-0001), keep all three in sync **manually within one transaction** (more testable than triggers): on chunk delete, `DELETE FROM vec_chunks WHERE chunk_id=?` and `DELETE FROM fts_chunks WHERE rowid=?` in the same tx; on insert, insert chunk row, then `INSERT INTO vec_chunks(chunk_id,embedding)` and `INSERT INTO fts_chunks(rowid,text)`. (External-content FTS5 also supports the `'delete'`/`'insert'` command rows if preferred — pick one and keep it consistent.) `embeddings` is never cascaded — it is the durable cache and is keyed by content hash, not by chunk id.

### Hybrid query shape
Dense: `SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH :qvec ORDER BY distance LIMIT :k` (validated syntax from the spike). Keyword: `SELECT rowid, rank FROM fts_chunks WHERE fts_chunks MATCH :q ORDER BY rank LIMIT :k`. Fuse the two ranked id-lists with **RRF** in TS (no server-side reranker; LanceDB's reranker is not in this stack — sqlite-vec + FTS5 + app-side RRF).

### Version-mismatch behavior (checked at open; auto-trigger a non-blocking background re-index with progress surfaced, not just "offer")
| meta key that mismatches | What is still valid | Action |
|---|---|---|
| `chunk_config_hash` | nothing about chunks | Full: re-extract (PDF only, from file_hash extraction cache where possible) + re-chunk + re-embed. Invalidates every cached embedding indirectly (new chunk_hashes). |
| `embedder_id` (dim same) | files, chunks, chunk text/hashes | Re-embed only: for each chunk_hash look up `embeddings(chunk_hash,new_embedder,dim)`; hit -> reuse, miss -> embed. Repopulate `vec_chunks` from cache. No re-extract/re-chunk. |
| `dimension` (with/without embedder change) | files, chunks | As above PLUS `DROP TABLE vec_chunks; CREATE VIRTUAL TABLE ... float[newdim]` (dim is immutable in vec0), then repopulate from cache hits / fresh embeds. |
| `schema_version` | depends on migration | Run forward migration if one exists; else rebuild index from vault. |
| index file missing/corrupt | nothing | Rebuild from vault (index is disposable by design). |

On open, also detect "vault indexed elsewhere" (embedder/dim in meta differ from the user's current default) and route to the same table.

**Why.** Mirrors the locked stack exactly (sqlite-vec brute-force KNN + FTS5 + metadata under .cairn/, hybrid-on, 1024-dim Qwen3 default) and the spike-validated vec0 syntax. The key structural choice — embeddings as a durable content-addressed cache and vec0 as a derived projection — is what operationalizes the locked cache key (chunk_hash, embedder_id, dimension): incremental re-embed becomes a hash lookup, switching back is free, and a blow-away rebuild of vec_chunks costs no model time. SQLite has no ENUM (CHECK constraint), virtual tables ignore FK cascade (explicit in-tx sync), and char_span is split to two INTEGERs for indexable range math.

**Open risks / TODOs.**
- ~2x vector storage: vectors live in both `embeddings` (durable) and `vec_chunks` (live). At ~4KB/chunk (1024 float32) this is acceptable at v1 scale; revisit if a large corpus + multiple cached embedders bloats the file (could GC non-active embedders from the cache).
- Templating DIM into the vec0 DDL string must read meta.dimension at create time; a hardcoded 1024 will silently break a switched-embedder rebuild — enforce that the create path always sources dim from meta.
- FTS5 external-content tables require the manual sync discipline to be correct or queries return stale/missing rows; needs an integration test that deletes a file and asserts vec0+fts5+chunks all drop together.


---

## G6 — Chunking parameters: 512 tokens / 15% overlap, structure-aware, with a chunk_config_hash

> **Recorded as an ADR:** [`docs/adr/0006-chunking-512-15-structure-aware.md`](adr/0006-chunking-512-15-structure-aware.md). Full spec below.

**Decision.** Chunk to a 512-token target with 15% overlap, splitting structure-first (markdown by heading hierarchy then size-cap; PDF per-page then sub-chunk oversized pages) using a separator-respecting recursive splitter. Stamp a chunk_config_hash into meta so any later parameter change is an explicit, surfaced re-index — never silent.

## Chunking spec

### Parameters (the active config)
- **Target size:** 512 tokens (~1800 characters at the spike's measured ratio).
- **Overlap:** 15% (~77 tokens / ~270 chars).
- **Token-length function:** char-approximation at **3.5 chars/token** (~1800 chars = 512 tok). Pin ONE function; do not mix a real tokenizer in some paths and char-approx in others (it changes boundaries -> changes chunk_hash). The approx ratio is what the Spike-A numbers were measured against.
- **Separators (recursive, in order):** `['\n\n', '\n', '. ', ' ', '']` (paragraph -> line -> sentence -> word -> char). This re-anchoring on `\n\n` is what keeps a one-paragraph edit contained (Spike A1/A2 = 94-96% cache hits).
- **Pre-hash normalization (applied before computing chunk_hash, NOT to stored display text):** collapse runs of whitespace, normalize line endings to `\n`, Unicode NFC. (Spike A fix #2 — absorbs cosmetic extraction drift.)

### Structure-aware strategy
- **Markdown (`note`, `flashcard`):** split by heading hierarchy first (H1>H2>H3 sections), then size-cap each section with the recursive splitter at 512/15%. Record the section's `heading_path` (`>`-joined slugs) on every chunk for G8 anchoring.
- **PDF (`pdf`):** chunk **per page first** (page is the citation unit, ADR-0004 / locked page-level citations), then sub-chunk any oversized page with the recursive splitter. `page` set on every chunk; `char_start/char_end` are offsets into that page's pinned extracted text. OCR'd pages carry `ocr=1`.
- **Annotation chunks (`annotation`):** the highlighted/quoted span + its note text from the PDF's vault sidecar (G8), one chunk per annotation unless oversized; `page` copied from the anchor.

### chunk_config_hash
`chunk_config_hash = SHA-256(JSON.stringify({ target_tokens:512, overlap_pct:15, chars_per_token:3.5, separators:[...], splitter:'recursive', splitter_version:'<pkg@semver>', normalize:'collapse-ws+nfc+lf' }))`, stored in `meta`. Any change to ANY of these fields changes the hash -> G5's version-mismatch path triggers a full re-extract/re-chunk/re-embed. This makes a parameter change an explicit, progress-surfaced re-index, never a silent partial corruption of the cache.

### Why 512/15% over the PRD's 800/100
1. **Evidence transfer:** the Spike-A cache-hit numbers (94-96% on structured prose) were measured at ~1800char≈512tok / 15%. Adopting that exact config is what lets those measured numbers transfer; 800/100 would be unmeasured extrapolation.
2. **Honest read of Spike A:** the spike's headline is that *hit-rate is dominated by extraction determinism (A4=0%) and separator structure (A3=0%), not by chunk size* — so 512 is NOT claimed to cache better than 800. 512 is chosen because it is the measured config AND gives finer retrieval precision and tighter citation granularity (smaller cited span) at v1.
3. **15% overlap (not 100 tokens):** the overlap-cascade fear is overstated for separator-respecting splitters (A1/A2 stay contained), so a modest 15% buys boundary recall without inflating chunk count or risking a cascade.

**Why.** 512/15% is the only config with measured cache-hit evidence behind it; everything else would be guesswork. Structure-first matches the locked node types and ADR-0004's page-level PDF citations. The chunk_config_hash turns the one truly hard-to-reverse lever (it invalidates every cached embedding) into an explicit, observable operation rather than silent drift.

**Open risks / TODOs.**
- The char/token approximation (3.5) is a heuristic; if Qwen3-Embedding-0.6B's real tokenizer diverges materially, chunks may run long against its 32K ctx (low risk at 512) — confirm the ratio against the actual tokenizer in a spike before locking.
- Heading-anchored markdown split helps A3 (run-on text) but does not fix A4 (re-extraction reflow) — that defense lives in G7, not here.
- Per-page PDF chunking can produce very small chunks on sparse pages; decide a min-chunk-merge rule (e.g. merge pages < N tokens with the next) before v1 or accept some tiny low-signal chunks.


---

## G7 — Per-chunk embedding cache (TS port) with extraction/chunking reuse and the A4 determinism defense

**Decision.** Embedding cache keyed (chunk_hash, embedder_id, dimension), backed by the durable `embeddings` table; extraction and chunking caches keyed by file_hash. On a file edit, re-embed only chunks whose chunk_hash is new; switching embedder reuses extraction+chunking and only re-embeds cache misses. The load-bearing risk is extraction determinism (Spike A4), defended by file_hash skip + pre-hash normalization + a pinned PDF-extraction cache.

## Embedding cache + reuse pipeline (TS)

### Three cache layers, two key spaces
| Layer | Key | Store | Reused when |
|---|---|---|---|
| Extraction (PDF only) | file_hash | `<vault>/.cairn/extract/<file_hash>.json` (pinned extractor output: per-page text + char offsets + ocr flag) | file unchanged, or chunk_config changed (re-chunk from cached deterministic text, no pdf.js/Tesseract re-run) |
| Chunking | file_hash + chunk_config_hash | in `chunks` rows (derived) | file + config unchanged |
| Embedding | (chunk_hash, embedder_id, dimension) | `embeddings` table | chunk text (normalized) unchanged AND that (embedder,dim) was computed before — incl. switching BACK |

Markdown/flashcard need NO extraction cache: the file *is* the text. Only PDFs (pdf.js getTextContent + reading-order sort + Tesseract/vision, ADR-0004) get the file_hash-keyed extraction cache.

### Incremental update on a file edit
1. mtime gate (Git-index style) -> if mtime+size unchanged, skip without hashing.
2. Hash file bytes -> if file_hash unchanged, skip entirely (NEVER re-extract — primary A4 defense).
3. If changed: (PDF) re-extract -> write extract cache; (MD) read text. Re-chunk at active chunk_config. For each new chunk compute chunk_hash = SHA-256(normalize(text)).
4. Diff new chunk_hashes vs the file's current chunk rows. For each chunk_hash: look up `embeddings(chunk_hash, active_embedder, active_dim)`; hit -> reuse vector, miss -> call embedder, INSERT into `embeddings`. Then rewrite the file's `chunks` rows and sync `vec_chunks`+`fts_chunks` in one tx (G5 discipline).
5. Stale chunk rows for removed chunk_indexes are deleted (cascade-safe in the same tx). `embeddings` rows are NOT deleted (content-addressed cache; a later edit that re-creates that text hits for free).

### Switch embedder (model-strategy: first-class op)
Reuse extraction + chunking caches entirely (keyed by file_hash, embedder-independent). Walk every chunk_hash, look up `embeddings(chunk_hash, NEW_embedder, dim)`; hit -> reuse (switch-back is free), miss -> embed. Rebuild `vec_chunks` for the new (embedder,dim) from the cache; if dimension changed, DROP+recreate vec_chunks first (G5). Update meta. Cost = embedding misses only, not re-parsing PDFs.

### A4 determinism defenses (carried from Spike A, ranked)
1. **file_hash skip** — unchanged file is never re-extracted, so reflow can't happen for untouched docs.
2. **pre-hash normalization** — collapse whitespace / NFC / LF before hashing absorbs cosmetic drift (Spike A fix #2).
3. **pinned PDF-extraction cache** — a chunk_config change re-chunks from the cached deterministic text, not from a fresh extractor run, so config edits don't trigger reflow.
4. **pin extractor versions** — pdf.js + tesseract.js versions are part of the build; a version bump is a deliberate full re-index event.

**Why.** This is the direct TS realization of the locked cache key and model-strategy's stated reuse contract (switching embedder reuses extraction/chunking, re-embeds only). Anchoring vectors in the durable `embeddings` table (G5) is what makes incremental re-embed and switch-back cheap. Spike A proved the real failure mode is extraction reflow, not the overlap cascade, so the defenses target exactly that.

**Open risks / TODOs.**
- DETERMINISM SPIKE TO RUN: Spike A4 measured the Python/Docling extractor. Cairn's TS path is pdf.js getTextContent + reading-order sort + tesseract.js (ADR-0004) — a DIFFERENT extractor whose run-to-run determinism is unconfirmed. Must spike: extract the same PDF twice with pinned versions and assert identical normalized per-page text (and stable char offsets). If non-deterministic, hit-rate collapses on every re-extract.
- Reading-order sort is itself a potential nondeterminism source (tie-breaking on equal coordinates) — verify the sort is total/stable.
- OCR (Tesseract) output can vary across versions/threads; confirm WASM Tesseract is deterministic for a fixed version, or treat OCR'd pages as always-re-embed-on-reindex.


---

## G8 — Citation anchor format (markdown fuzzy / PDF page-level) and staleness handling

> **Recorded as an ADR:** [`docs/adr/0007-external-fuzzy-citation-anchors.md`](adr/0007-external-fuzzy-citation-anchors.md). Full spec below.

**Decision.** Markdown citations anchor by stable heading-slug + char offset + a short context window, fuzzy-resolved at click time via vendored diff-match-patch (Apache-2.0); PDF citations are page + char range + quote snippet, where the page is always stable. Annotations live in a vault sidecar keyed by SHA-256(PDF content), not path. v1 accepts approximate markdown anchors after large edits; a citation-health-check batch op ships in v1.1.

## Citation anchor formats

### Markdown anchor (note / flashcard)
```json
{
  "node": "path/to/note.md",        // current path (informational; may move)
  "heading_slug": "methods>kalman-filter", // stable-ish: '>'-joined heading slug path
  "char_offset": 1423,             // offset within the resolved section's text
  "context": { "prefix": "...last ~32 chars before", "quote": "the cited span", "suffix": "first ~32 chars after..." }
}
```
Resolve order at click time: (1) locate the section by heading_slug; (2) try exact text at char_offset; (3) on miss, **fuzzy-match the quote within a window around char_offset using diff-match-patch `match_main`** (Apache-2.0); (4) on low-confidence match, surface "approximate location" and jump to the section head. No stable IDs are injected into the user's markdown — the anchor is fully external.

### PDF anchor (pdf node / annotation)
```json
{
  "pdf_content_hash": "sha256:...", // identity of the PDF bytes; survives rename/move
  "page": 7,                        // ALWAYS stable — primary anchor; ADR-0004 page-level citations
  "char_start": 210, "char_end": 318, // range within the page's PINNED extracted text (G7)
  "quote": "the cited sentence"     // recovery key if extractor version shifts offsets
}
```
Resolve: jump to `page` (always works). Highlight char_start..char_end against the pinned extraction; if the extractor version changed and offsets shifted, re-find `quote` on the page. Page-level citation absorbs OCR noise (ADR-0004): worst case the user lands on the right page.

### Annotation sidecar (VAULT artifact, not the index)
Annotations are USER DATA, so they live in the vault (durable, synced, plain-text — ADR-0003 "delete the app, keep everything readable"), NOT in the disposable `.cairn/` index. Store at `<vault>/.cairn-annotations/<pdf_content_hash>.json` OR as a Markdown stub beside the PDF — keyed by **SHA-256(PDF content), not path**, so annotations survive rename/move and re-bind after a blow-away re-index. The index holds only *derived* `source_type='annotation'` chunks for retrieval; content-hash keying is exactly what lets those derived chunks re-attach to the PDF on rebuild. (NB: if the sidecar is under `.cairn/`, that subpath must be exempt from the disposable/git-ignore rule; preferred is a synced location.)

### Staleness policy
- **PDF:** effectively stable (page never drifts; quote recovers offset drift). No health check needed.
- **Markdown:** v1 accepts approximate anchors after large edits (fuzzy match may degrade to section-level). **v1.1: a citation-health-check batch op** re-resolves all markdown anchors, flags low-confidence ones, and offers re-anchoring.

### License note (load-bearing permissive-only policy)
`diff-match-patch` is **Apache-2.0** — clean to vendor. apache/annotator and Hypothesis are archived design references only. A maintained TS fork exists if preferred over vendoring the original.

**Why.** Page-level PDF anchoring is locked (ADR-0004) and is the robust case; the only genuinely fuzzy surface is markdown, handled with the well-trodden quote+offset+context pattern resolved by an Apache-licensed matcher. Content-hash keying for annotations is what makes them survive renames and index rebuilds and is the reason source_type has an 'annotation' value at all. Keeping annotations in the vault honors the plain-files invariant; keeping no stable IDs in the markdown honors Obsidian-compatibility.

**Open risks / TODOs.**
- diff-match-patch is unmaintained upstream — vendoring pins it, but confirm the vendored copy's Apache-2.0 LICENSE travels with it (license-audit item).
- PDF char offsets are stable only relative to G7's pinned extraction; an extractor version bump shifts offsets and makes `quote` the sole recovery key — if quote is also OCR-noisy, recovery degrades to page-only (acceptable per ADR-0004 but worth stating).
- Sidecar location must not be swept by the disposable-index rule; decide the exact path + git-ignore exemption before v1 or annotations get wiped on a re-index.
- Fuzzy markdown anchoring has no correctness guarantee — large edits can silently move a citation; the v1.1 health-check is the only backstop until then.


---

## G10 — search_notes retrieval API: filter schema, RRF fusion, cosine coverage gate, ungrounded toggle

**Decision.** search_notes(query, opts?) is a pure-data, headless engine call (ADR-0001) that runs hybrid retrieval — dense (sqlite-vec, cosine) + FTS5 keyword, fused with RRF (K=60) — and returns the top-k=8 chunks each carrying G5 metadata, a G8 citation anchor, a raw cosine similarity, an RRF ordering score, and which retriever(s) hit. v1 implements folders+types filters (tags deferred). The 'not covered' verdict is computed on the MAX cosine over the filtered candidate POOL (before the RRF trim), against an absolute cosine floor (default 0.5, tunable). The ungrounded answer is an Ask-layer per-message toggle (visually-distinct container, sticky-per-session) that consumes the engine's covered:boolean — it is NOT part of the engine signature.

## `search_notes` — signature & return type (engine; no DOM/Electron, ADR-0001)

```ts
type NodeType = 'note' | 'pdf' | 'flashcard' | 'annotation';
type Retriever = 'dense' | 'fts';

interface SearchFilter {
  folders?: string[];   // vault-relative POSIX prefixes; OR within list. v1 implemented.
  types?: NodeType[];   // source_type IN (...); OR within list. v1 implemented.
  tags?: string[];      // DEFERRED v1.1 (no tag column in G5); accepted but ignored at runtime in v1.
}

interface SearchOptions {
  k?: number;             // RETURNED count, default 8
  filter?: SearchFilter;
  candidatePool?: number; // per-arm over-fetch, default 64
}

type CitationAnchor =
  | { kind: 'markdown'; node: string; heading_slug: string | null; char_offset: number | null;
      context: { prefix: string; quote: string; suffix: string } }
  | { kind: 'pdf'; pdf_content_hash: string; page: number;
      char_start: number | null; char_end: number | null; quote: string };

interface RetrievedChunk {
  chunk_id: number; file: string; source_type: NodeType; chunk_index: number;
  text: string; heading_path: string | null; page: number | null;
  char_start: number | null; char_end: number | null; ocr: boolean; block_type: string | null;
  anchor: CitationAnchor;          // G8 ready-to-jump citation
  cosine: number;                  // raw cosine SIMILARITY in [-1,1]; gate + display; ALWAYS present
  rrf_score: number;               // fused rank score; ORDERING ONLY (no magnitude)
  retrievers: Retriever[];         // ['dense'] | ['fts'] | ['dense','fts']
}

interface SearchResult {
  query: string; k: number;
  covered: boolean;                // gate on FILTERED POOL max cosine, before RRF trim
  pool_max_cosine: number;         // the value compared to the threshold
  coverage_threshold: number;      // absolute cosine floor, default 0.5 (tunable)
  chunks: RetrievedChunk[];        // top-k after RRF fuse + trim, desc rrf_score
}

declare function search_notes(query: string, opts?: SearchOptions): Promise<SearchResult>;
```

## RRF merge (applied before the trim — and what it is NOT)
`rrf_score(chunk) = Σ_arm weight_arm / (K_RRF + rank_arm(chunk))`, with **K_RRF = 60**, **1-based** per-arm ranks (best=1), **equal weights** (dense=fts=1.0), and a chunk contributing a term **only for arms that returned it**. RRF uses ranks ONLY and discards magnitude → `rrf_score` carries no cosine info and MUST NOT drive the coverage gate or any similarity display. Cosine is a separate field for exactly this reason.

## Pipeline (order is load-bearing)
1. Embed query once → `qvec` (Qwen3-Embedding-0.6B, 1024-dim).
2. **Dense arm:** `SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH :qvec ORDER BY distance LIMIT :pool` (pool=64). With `distance_metric=cosine`, `cosine = 1 - distance` per hit (free).
3. **FTS arm:** `SELECT rowid AS chunk_id, rank FROM fts_chunks WHERE fts_chunks MATCH :q ORDER BY rank LIMIT :pool`. Malformed/empty MATCH → treat FTS arm as empty, never throw.
4. **Join + filter:** union candidate ids, join `chunks` to hydrate G5 fields + build G8 anchors, apply filter (`folders` prefix-OR, `types` IN). Post-KNN (vec0 v0.1.9 has no pre-filtered KNN). `tags` ignored in v1.
5. **Cosine for every survivor:** dense hits already have it; for **FTS-only** survivors compute `vec_distance_cosine(:qvec, vector)` against the stored vector (verified in spike). Now every candidate carries a cosine.
6. **Coverage gate:** `pool_max_cosine = max(cosine)` over the **filtered candidate pool from step 5** (NOT the trimmed result). `covered = pool_max_cosine >= coverage_threshold`.
7. **RRF fuse + trim:** fuse filtered pool, sort by `rrf_score` desc, trim to k=8, set `retrievers`, return.

Why the gate is step 6 not step 7: RRF favors both-arm hits, so the single highest-cosine chunk (often dense-only) can be evicted past rank 8 in the trim. Gating on the returned 8 would falsely say 'not covered' while the closest note sat at e.g. cosine 0.7 — a false negative exactly where coverage matters. Pool-max gate sees every filtered candidate, so the trim cannot fool it. It's free because every candidate already has a cosine.

## 'Not covered' gate
- `coverage_threshold` default **0.5**, an **ABSOLUTE** cosine floor (NOT batch/min-max — min-max always seats a 1.0 and never fires). Tunable in `meta`; calibrate on the same 50-Q Qwen3-Embedding-0.6B self-test the v1-scope build-prereq uses. 0.5 is documented-but-unvalidated until that spike runs.
- `covered = pool_max_cosine >= coverage_threshold` over the **filtered** pool → 'do your notes *in this scope* cover this'.
- Empty index / empty query / both arms empty → empty pool → `covered=false`, `chunks=[]`, no throw.

## Ask-mode orchestration (UI layer — consumes `covered`, NOT in the engine signature)
- `covered === true` → Ask answers grounded, cites every claim from `chunks` via G8 anchors.
- `covered === false` → Ask says **"your notes don't cover this"**, does NOT answer from general knowledge by default.
- **Ungrounded toggle:** explicit **per-message** opt-in for a general-knowledge answer; renders in a **visually-distinct container** marked ungrounded; opt-in is **sticky per session** (reset on new session), never a silent persisted default.
- Kept out of `search_notes` to preserve headless engine (ADR-0001 line 13).

## Amendment to G5/G7 — vec0 must be cosine
The G5 DDL/spike are L2; the gate needs cosine. Amend the vec0 table:
```sql
CREATE VIRTUAL TABLE vec_chunks USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding float[1024] distance_metric=cosine   -- DIM templated from meta.dimension
);
```
Verified (sqlite-vec v0.1.9): KNN `distance = 1 - cosine_similarity`, so `cosine = 1 - distance` free per dense hit; ranking unchanged on unit vectors. `vec_distance_cosine(a,b)` scalar available for FTS-only cosine. Durable `embeddings` cache bytes unchanged (still float32) — a one-token DDL change, not a re-embed.

**Why.** Reuses the spike-validated query shapes and locked HYBRID-ON / k=8 / Qwen3-1024 stack, and the PRD §6 Ask contract verbatim ("your notes don't cover this" + ungrounded toggle behind an explicit toggle). The load-bearing insight is that RRF is rank-only — it discards the magnitude the coverage gate needs — so cosine is carried as its own field and the gate runs on the filtered candidate pool's max cosine BEFORE the RRF trim. Gating on the trimmed top-k would misfire as a false 'not covered' because RRF systematically demotes high-cosine single-arm hits below both-arm hits. distance_metric=cosine (empirically confirmed in sqlite-vec v0.1.9) makes the gate read cosine directly off dense distance; vec_distance_cosine covers FTS-only hits. Filter scope (folders+types, defer tags) and the headless engine / UI-layer split follow ADR-0001 and the stated G10 recommendation.

**Open risks / TODOs.**
- coverage_threshold=0.5 is unvalidated for Qwen3-Embedding-0.6B — calibrate against the 50-Q self-test build-prereq before locking; store as one absolute float in meta.
- Selective-filter underflow: pool=64 then post-filter to a small folder can leave < k survivors (vec0 v0.1.9 has no pre-filtered KNN); v1 accepts it, larger vaults may need a bigger pool or iterative widening.
- Free-text-to-FTS5-MATCH sanitization (quotes/operators) must be robust; malformed input degrades the FTS arm to empty, never throws.
- tags filter is type-visible but a runtime no-op in v1; callers must not assume it filters.
- The cosine amendment requires the G5 vec0 DDL to be updated and re-confirmed against G7's stored-vector contract (bytes unchanged, but the live vec_chunks projection changes metric).


---

## G12 — Model-manifest schema + load strategy

**Decision.** Ship a single `model-manifest.json` (with a distinct `schema_version` for parseability and `version`/`last_updated` for freshness) that maps tiers T0-T4 to chat models (primary + alternates), the app-wide embedder, cloud rungs, escalation thresholds, and the memory-fit constants. Bundle it in-app as the offline-first floor; layer an optional, default-OFF refresh from a pinned HTTPS host on top, then a per-machine user override on top of that. Every layer is schema-validated data, never executed; validation failure falls back silently with a non-blocking warning.

## G12 — `model-manifest.json` schema + load strategy

### Purpose & invariants
- The manifest is the **single source of truth** for every value that churns faster than app releases: tier→model mapping, footprints, cloud rungs/prices, escalation thresholds, and the memory-fit constants. ADR-0002 mandates this be data, not code.
- **Zero hard-coded numbers in TS.** `mapToTier` and `computeFit` (G13) are pure functions of `(profile, manifest)`. Every threshold/constant they need lives under `tiers`, `escalation`, or `memory_model` here. This is the discriminating test that G12 and G13 fit together.
- **No secrets.** BYOK API keys live in Electron `safeStorage`, never in the manifest. Cloud rungs carry only model id / price / context / when-to-use.
- **Data, not code.** A fetched or user-edited manifest is JSON-schema-validated and consumed as data; it is never `eval`'d or used to construct a code path. Same philosophy as v1-scope's "user-editable mode JSON behind a validation layer."

### Exact JSON shape (bundled seed — June-2026 snapshot from `docs/model-strategy.md`)
```json
{
  "schema_version": 1,
  "version": "2026.06.14",
  "last_updated": "2026-06-14T00:00:00Z",
  "source": "bundled",
  "notes": "Point-in-time snapshot. Re-verify sizes/prices against ollama.com + vendor pages before relying on them. Qwen3.5/Gemma4 deliberately excluded as unverifiable (see model-strategy.md).",

  "memory_model": {
    "apple_wired_fraction_below_64gb": 0.66,
    "apple_wired_fraction_at_64gb_plus": 0.75,
    "fit_target_fraction": 0.80,
    "min_free_fraction": 0.30,
    "os_reserve_gb": 3.0,
    "browser_reserve_gb": 2.0,
    "kv_cache_reserve_gb": 1.5,
    "_comment": "budget = min(wired_ceiling, total - os_reserve - browser_reserve - embedder_footprint(if co-resident) - kv_cache_reserve); a model 'fits' when footprint <= budget * fit_target_fraction AND (total - footprint) >= total * min_free_fraction. Constants measured on a 128GB dev machine — recalibrate on 8-16GB hardware."
  },

  "tiers": {
    "T0": {
      "label": "cloud-lean",
      "min_total_ram_gb": 0,
      "max_total_ram_gb": 8,
      "requires_discrete_gpu": false,
      "resident_budget_gb": 1.5,
      "pin_chat": false,
      "pin_embedder": true,
      "chat_model": {
        "primary": { "id": "qwen3:1.7b", "footprint_gb": 1.4, "context_default": 4096, "license": "Apache-2.0", "license_status": "clean" },
        "alternates": [
          { "id": "qwen3:0.6b", "footprint_gb": 0.523, "context_default": 4096, "license": "Apache-2.0", "license_status": "clean" }
        ]
      },
      "notes": "Don't pin chat resident; route real work to cloud."
    },
    "T1": {
      "label": "entry",
      "min_total_ram_gb": 8,
      "max_total_ram_gb": 12,
      "requires_discrete_gpu": false,
      "resident_budget_gb": 3.0,
      "pin_chat": false,
      "pin_embedder": true,
      "chat_model": {
        "primary": { "id": "qwen3:4b", "footprint_gb": 2.5, "context_default": 4096, "license": "Apache-2.0", "license_status": "clean" },
        "alternates": []
      },
      "notes": "Standout small model; unload between bursts."
    },
    "T2": {
      "label": "mid (modal student machine)",
      "min_total_ram_gb": 12,
      "max_total_ram_gb": 24,
      "requires_discrete_gpu": false,
      "resident_budget_gb": 6.0,
      "pin_chat": true,
      "pin_embedder": true,
      "chat_model": {
        "primary": { "id": "qwen3:8b", "footprint_gb": 5.2, "context_default": 8192, "license": "Apache-2.0", "license_status": "clean" },
        "alternates": []
      },
      "notes": "Mainstream default; first tier comfortable for concurrent embed+chat."
    },
    "T3": {
      "label": "high",
      "min_total_ram_gb": 24,
      "max_total_ram_gb": 48,
      "requires_discrete_gpu": false,
      "resident_budget_gb": 14.0,
      "pin_chat": true,
      "pin_embedder": true,
      "chat_model": {
        "primary": { "id": "qwen3:14b", "footprint_gb": 9.3, "context_default": 8192, "license": "Apache-2.0", "license_status": "clean" },
        "alternates": [
          { "id": "qwen3:30b-a3b", "footprint_gb": 19.0, "context_default": 8192, "license": "Apache-2.0", "license_status": "clean", "note": "MoE; faster decode at 24GB+, prefer for responsiveness" }
        ]
      },
      "notes": "30B-A3B MoE keeps decode fast despite larger footprint."
    },
    "T4": {
      "label": "power",
      "min_total_ram_gb": 48,
      "max_total_ram_gb": null,
      "requires_discrete_gpu": false,
      "resident_budget_gb": 28.0,
      "pin_chat": true,
      "pin_embedder": true,
      "chat_model": {
        "primary": { "id": "qwen3:30b-a3b", "footprint_gb": 19.0, "context_default": 8192, "license": "Apache-2.0", "license_status": "clean", "note": "Often the better always-on pick for responsiveness" },
        "alternates": [
          { "id": "qwen3:32b", "footprint_gb": 20.0, "context_default": 8192, "license": "Apache-2.0", "license_status": "clean" }
        ]
      },
      "notes": "30B-A3B preferred for always-on responsiveness over dense 32B."
    }
  },

  "downgrade_rules": [
    {
      "id": "low-ram-no-gpu-cap-at-4b",
      "when": { "max_total_ram_gb": 8, "discrete_gpu": false },
      "force_chat_model": "qwen3:4b",
      "rationale": "8GB / no-GPU machines OOM or CPU-spill an 8B; cap chat at Qwen3-4B even if other signals point higher."
    }
  ],

  "embedder": {
    "default": {
      "id": "qwen3-embedding:0.6b",
      "dim": 1024,
      "footprint_gb": 0.639,
      "context": 32768,
      "license": "Apache-2.0",
      "license_status": "clean",
      "note": "App-wide default for EVERY tier (not per-tier). Switching re-indexes the vault."
    },
    "switch_targets": [
      { "id": "nomic-embed-text:v1.5", "dim": 768, "footprint_gb": 0.274, "context": 8192, "license": "Apache-2.0", "license_status": "clean" },
      { "id": "embeddinggemma:300m", "dim": 768, "footprint_gb": 0.622, "context": 2048, "license": "Gemma Terms", "license_status": "flagged-non-osi" },
      { "id": "qwen3-embedding:4b", "dim": 2560, "footprint_gb": 2.5, "context": 32768, "license": "Apache-2.0", "license_status": "clean" },
      { "id": "qwen3-embedding:8b", "dim": 4096, "footprint_gb": 4.7, "context": 32768, "license": "Apache-2.0", "license_status": "clean" }
    ]
  },

  "cloud_rungs": {
    "cheap_fast": {
      "label": "Cheap-fast",
      "when": "Quick assists, high-volume summarization; T0/T1 everyday",
      "models": [
        { "provider": "anthropic", "id": "claude-haiku-4-5", "price_in_per_mtok": 1.0, "price_out_per_mtok": 5.0, "context": 200000 },
        { "provider": "openai", "id": "gpt-5.x-mini", "price_in_per_mtok": 0.75, "price_out_per_mtok": 4.5, "context": 400000, "verify": true },
        { "provider": "google", "id": "gemini-2.5-flash-lite", "price_in_per_mtok": 0.10, "price_out_per_mtok": 0.40, "context": 1000000 }
      ]
    },
    "balanced": {
      "label": "Balanced (default escalate)",
      "when": "Long readings, essay feedback, multi-doc synthesis, image PDFs",
      "default": true,
      "models": [
        { "provider": "anthropic", "id": "claude-sonnet-4-6", "price_in_per_mtok": 3.0, "price_out_per_mtok": 15.0, "context": 1000000 },
        { "provider": "openai", "id": "gpt-5.4", "price_in_per_mtok": 2.5, "price_out_per_mtok": 15.0, "context": 1100000 }
      ]
    },
    "frontier": {
      "label": "Frontier",
      "when": "Hardest reasoning, agentic chains; Gemini for huge-context synthesis",
      "models": [
        { "provider": "anthropic", "id": "claude-opus-4-8", "price_in_per_mtok": 5.0, "price_out_per_mtok": 25.0, "context": 1000000 },
        { "provider": "openai", "id": "gpt-5.5", "price_in_per_mtok": 5.0, "price_out_per_mtok": 30.0, "context": 400000 },
        { "provider": "google", "id": "gemini-3.1-pro", "price_in_per_mtok": 2.0, "price_out_per_mtok": 12.0, "context": 2000000 }
      ]
    }
  },

  "escalation": {
    "_comment": "Numeric triggers consumed by the router. Qualitative triggers (failed self-check, user 'try harder', vision/audio the local model can't parse) are routing logic, NOT manifest values.",
    "per_tier_thresholds": {
      "T0": { "context_tokens_gt": 4096, "tool_count_gt": 3 },
      "T1": { "context_tokens_gt": 4096, "tool_count_gt": 3 },
      "T2": { "context_tokens_gt": 8192, "tool_count_gt": 3 },
      "T3": { "context_tokens_gt": 8192, "tool_count_gt": 3 },
      "T4": { "context_tokens_gt": 32768, "tool_count_gt": 6 }
    },
    "default_rung": "balanced",
    "prefer_cheapest_viable_rung": true
  },

  "remote_refresh": {
    "enabled": false,
    "url": "https://manifest.cairn.app/model-manifest.json",
    "check_interval_hours": 168,
    "_comment": "Default OFF. When enabled, the ONLY sanctioned outbound call beyond user-configured model endpoints. Pinned HTTPS host. Fetched copy is validated data, cached under .cairn/, never executed."
  }
}
```

### Load strategy (precedence + validation)
Resolve the effective manifest at app start (and on a manual "refresh" action) by merging three layers, **highest precedence last**:

1. **Bundled** (`app/resources/model-manifest.json`) — the offline-first floor. Always present, ships with the app, guaranteed schema-valid. This alone makes Cairn fully usable offline at first run.
2. **Fetched-remote** (`.cairn/model-manifest.cache.json`) — applied **only if ALL hold**: `remote_refresh.enabled === true`, the fetch succeeded over the pinned HTTPS host, the payload JSON-schema-validates, `schema_version` is in the app's supported set, AND `last_updated` is strictly newer than the layer below. Otherwise ignored.
3. **User override** (`.cairn/model-manifest.override.json`) — a per-machine, never-synced power-user layer. Shallow-merged over the result; same validation gate. Lets a user pin a model or tweak a threshold without waiting for a release.

**Validation contract:**
```ts
type ManifestSource = 'bundled' | 'remote' | 'override';
interface ManifestLoadResult {
  manifest: ModelManifest;          // the merged, effective manifest
  appliedLayers: ManifestSource[];  // e.g. ['bundled','override']
  warnings: string[];               // non-blocking: e.g. 'remote manifest schema_version 2 unsupported, ignored'
}
function loadManifest(opts: {
  bundledPath: string;
  cachePath: string;
  overridePath: string;
  supportedSchemaVersions: number[]; // app compile-time constant, the ONE allowed hard-coded value
}): ManifestLoadResult;
```
- Any layer that fails validation (bad JSON, schema mismatch, unsupported `schema_version`) is **dropped, not fatal** — push a `warning`, fall through to the next-lower valid layer. The bundled layer can never be dropped (it is the floor; if it somehow fails to parse, that is a build-time error, not a runtime path).
- The effective manifest is **user-inspectable**: surface the merged JSON + `appliedLayers` in Settings so the user can see exactly which model picks/prices are live and where they came from.

**Why.** ADR-0002 already ratified "runtime-updatable manifest, not hard-coded" and "cloud is opt-in escalation"; this gives that decision a concrete, paste-able shape. Distinct `schema_version` vs `version` separates compatibility-gating from freshness-gating so the app can refuse an incompatible future manifest without refusing a merely-newer one. Putting every constant (memory-fit fractions, escalation thresholds, footprints) in the manifest is what lets G13's `mapToTier`/`computeFit` be pure with zero baked-in numbers — the test the advisor flagged as discriminating. `chat_model.{primary,alternates}` preserves the strategy doc's load-bearing alternates (0.6B fallback at T0, 30B-A3B MoE at T3/T4). Default-OFF remote refresh keeps the zero-outbound invariant intact while still solving model churn; validating-but-never-executing the fetched JSON mirrors the established mode-JSON safety pattern.

**Open risks / TODOs.**
- Seed model names/sizes/prices are a June-2026 snapshot needing re-verification against ollama.com + vendor pages; Qwen3.5/Gemma4 deliberately excluded as unverifiable 'phantom' releases — re-add only once confirmed.
- Cloud point-versions (gpt-5.x-mini, gpt-5.4/5.5, gemini-3.1-pro) carry verify:true flags; only the Anthropic ids are confirmed against this environment.
- Remote-manifest integrity beyond TLS (e.g. detached signature / checksum pinning) is deferred — a compromised pinned host could ship a manifest that points users at a malicious Ollama tag. Flag for a later hardening pass, do not build now.
- schema migration policy (how the app upgrades a v1 cached manifest to a future v2) is unspecified; for now unsupported schema_version simply falls back to bundled.


---

## G13 — First-run hardware-detection contract + escalation thresholds

**Decision.** Detect hardware app-side (not in the headless engine) via a thin impure `probeHardware()` that returns a `HardwareProfile`, then feed it plus the manifest into two pure functions — `mapToTier()` and `computeFit()` — that decide the tier, apply the 8B downgrade rule, and badge which models fit (~80% mem target, KV headroom). All constants and thresholds come from the manifest; the GPU/Metal probe degrades to a conservative fallback when Ollama or the system probe is absent. Power users may override the recommendation with a warning.

## G13 — first-run hardware-detection contract + tier mapping + escalation thresholds

### Where this lives
Hardware detection is **app-layer** (ModelGateway / first-run flow), **not** the headless engine — ADR-0001 keeps the engine free of platform/OS deps. The detection split below isolates the one impure piece so the decision logic stays pure and unit-testable, satisfying ADR-0001's testability spirit.

### Contract: split impure probe from pure decision
```ts
// ---- 1. IMPURE: the only part that touches the OS. Pluggable; degrades gracefully. ----
interface HardwareProfile {
  platform: 'darwin' | 'win32' | 'linux';
  totalRamGb: number;        // os.totalmem() / 1024^3
  freeRamGb: number;         // os.freemem() at probe time (advisory only)
  appleSilicon: boolean;     // arch === 'arm64' && platform === 'darwin'
  gpu: {
    kind: 'metal' | 'discrete' | 'integrated' | 'none' | 'unknown';
    vramGb: number | null;   // null when not applicable/undetectable (e.g. Apple unified)
  };
  probeConfidence: 'measured' | 'fallback'; // 'fallback' => GPU probe failed/absent
}

// Implementation notes (not load-bearing for the contract):
//  - RAM: os.totalmem()/os.freemem() (always available, Cairn-side).
//  - Apple GPU/Metal: 'system_profiler SPDisplaysDataType' or a Metal API probe.
//  - Win/Linux discrete VRAM: a GPU probe (e.g. WMI / nvidia-smi / sysfs).
//  - Ollama may be ABSENT at first run, so do NOT rely on it for detection.
function probeHardware(probes?: {
  gpuProbe?: () => Promise<HardwareProfile['gpu']>; // injectable for tests / per-OS impl
}): Promise<HardwareProfile>;

// FALLBACK: if the gpuProbe throws or is unavailable, return
//   { kind: 'unknown', vramGb: null } and set probeConfidence: 'fallback'.
//   Downstream treats 'unknown'/'fallback' as 'assume no discrete GPU' (conservative => lower tier).

// ---- 2. PURE: zero hardware access, zero baked-in numbers. Reads constants from the manifest. ----
interface TierAssignment {
  tier: 'T0' | 'T1' | 'T2' | 'T3' | 'T4';
  reason: string;                 // e.g. '16GB unified, no discrete GPU -> T2'
  appliedDowngrade?: string;      // downgrade_rule id if one fired
  recommendedChatModel: string;   // post-downgrade ollama id
  recommendedEmbedder: string;    // always manifest.embedder.default.id
  pinChat: boolean;               // from tier.pin_chat
  pinEmbedder: boolean;           // from tier.pin_embedder
}
function mapToTier(profile: HardwareProfile, manifest: ModelManifest): TierAssignment;

interface FitResult {
  modelId: string;
  fits: boolean;                  // footprint <= budget * fit_target_fraction AND free-after >= min_free
  budgetGb: number;               // computed resident budget
  footprintGb: number;
  badge: 'fits' | 'tight' | 'wont-fit';
  note?: string;                  // e.g. 'exceeds Metal wired ceiling'
}
function computeFit(modelId: string, profile: HardwareProfile, manifest: ModelManifest): FitResult;
```

### Memory-fit formula (all constants from `manifest.memory_model`)
```
wired_ceiling =
  apple_silicon
    ? total * (total >= 64 ? apple_wired_fraction_at_64gb_plus : apple_wired_fraction_below_64gb)
    : (gpu.kind === 'discrete' ? gpu.vramGb : total)   // discrete VRAM is a hard wall

embedder_cost = pin_embedder_for_tier ? embedder.default.footprint_gb : 0
budget = min(wired_ceiling,
             total - os_reserve_gb - browser_reserve_gb - embedder_cost - kv_cache_reserve_gb)

fits = footprint <= budget * fit_target_fraction
       AND (total - footprint) >= total * min_free_fraction
badge = fits ? 'fits'
      : footprint <= budget ? 'tight'
      : 'wont-fit'
```
- Apple: unified memory × Metal wired fraction (0.66 <64GB, 0.75 ≥64GB).
- Windows/Linux discrete: VRAM is the hard wall (no spill to system RAM without a big penalty).
- Embedder is co-resident only where `tier.pin_embedder` is true (T2+ in the seed); subtract it there, not on T0/T1.

### Tier-mapping table (a VIEW of `manifest.tiers`, not a second source)
| Tier | RAM gate | GPU | Resident budget | Pin chat / embed | Recommended chat |
|---|---|---|---|---|---|
| T0 | ≤8 GB | integrated/none | ~1.5 GB | no / yes | Qwen3-1.7B (alt 0.6B) |
| T1 | 8–12 GB | weak/none | ~3 GB | no / yes | Qwen3-4B |
| T2 | 12–24 GB | unified or ~8 GB VRAM | ~6 GB | yes / yes | Qwen3-8B |
| T3 | 24–48 GB | M Pro/Max or 12–16 GB VRAM | ~14 GB | yes / yes | Qwen3-14B (alt 30B-A3B) |
| T4 | ≥48 GB | M Max/Ultra or 24 GB+ VRAM | ~28 GB | yes / yes | Qwen3-30B-A3B (alt 32B) |

`mapToTier` walks tiers high→low and picks the highest tier whose `min_total_ram_gb` ≤ `totalRamGb` (and, for Win/Linux, whose VRAM expectation is met), then applies `downgrade_rules`.

### The 8B gate as an explicit downgrade rule
```
if (totalRamGb <= 8 && profile.gpu.kind !== 'discrete')
   force recommendedChatModel = manifest.downgrade_rules['low-ram-no-gpu-cap-at-4b'].force_chat_model  // qwen3:4b
```
This fires **after** tier selection — an 8GB/no-GPU machine that lands at T1/T2 by RAM still gets capped at Qwen3-4B. Recorded in `TierAssignment.appliedDowngrade`.

### Power-user override
The user may override the recommended tier/model in Settings. Override is **allowed and persisted to `.cairn/model-manifest.override.json`** (G12 layer 3); if the chosen model's `computeFit` returns `wont-fit`, show a non-blocking warning ("may OOM or spill to CPU") but do not prevent it.

### Escalation thresholds (single source = `manifest.escalation`, presented here as a view)
| Tier | escalate when context > | OR tool_count > |
|---|---|---|
| T0 | 4 096 | 3 |
| T1 | 4 096 | 3 |
| T2 | 8 192 | 3 |
| T3 | 8 192 | 3 |
| T4 | 32 768 | 6 |
- These are the **numeric** triggers, read by the router from `manifest.escalation.per_tier_thresholds`. T4 is filled explicitly (the doc left it implicit as "rarely escalate"): it escalates only on context beyond its own large window or tool-fan-out > 6.
- **Qualitative** triggers are routing logic, not manifest values: failed self-check, explicit user "try harder", and vision/audio the local model can't parse. These bypass the numeric table.
- On escalation, pick the **cheapest viable rung** (`prefer_cheapest_viable_rung`), default to `balanced`, and always surface target model + estimated cost/reason before spending (ADR-0002 trust requirement).

**Why.** Splitting `probeHardware` (impure, injectable, the only OS-touching code) from `mapToTier`/`computeFit` (pure, manifest-driven) is the cleanest way to keep the decision logic unit-testable with synthetic profiles and to honor ADR-0001's headless/testable spirit even though detection is app-layer. Driving every constant and threshold from the manifest is what makes the 'runtime-updatable, not hard-coded' decision real: the TS contains zero magic numbers, so a manifest refresh re-tunes tiers, fit, and escalation without a release. Branching the wired-ceiling on Apple-unified vs discrete-VRAM matches the strategy doc's hard physical difference (Metal wired fraction vs VRAM wall). Encoding the 8B gate as an explicit downgrade rule (not a tier boundary) captures the doc's specific 8GB/no-GPU→4B guidance, which pure RAM-thresholding would miss. The conservative GPU-probe fallback handles the task's flag that Ollama may be absent at first run.

**Open risks / TODOs.**
- Memory-fit constants (Metal 0.66/0.75 wired fractions, OS/browser/KV reserves, 80% target) were measured on a 128GB dev machine per CLAUDE.md — they MUST be recalibrated on real 8-16GB student hardware before trusting the 'fits' badges; current numbers are best-case ceilings.
- The GPU/Metal probe is platform-specific (system_profiler vs WMI/nvidia-smi/sysfs) and can fail or be absent; the conservative 'unknown -> assume no discrete GPU' fallback may under-tier a real GPU machine until the user overrides.
- freeRamGb is advisory only (varies moment-to-moment); tiering keys off totalRamGb to stay deterministic, but a heavily-loaded machine could still OOM at the recommended model — runtime keep_alive/unload policy (separate from G13) must catch this.
- Escalation thresholds are heuristic seeds; the context>X / tool_count>Y boundaries need validation against the real agent loop (the v1-scope 5-step agent-loop spike) before they're trusted.


---

## G14 — Agent write-safety: loop semantics, auto-snapshot, per-file approval, atomic commit, and byte-identical run revert

> **Recorded as an ADR:** [`docs/adr/0008-agent-write-safety-and-run-revert.md`](adr/0008-agent-write-safety-and-run-revert.md). Full spec below.

**Decision.** All write-modes (Synthesize, Recall, Plan, Agent) run on one headless write-safety core: a git checkpoint commit is taken BEFORE any write, every write passes a per-file diff-approval gate (injected as an async callback so the engine stays Electron/DOM-free per ADR-0001), all approved writes of a run land in exactly ONE commit, the Agent loop hard-stops at a manifest-configurable step cap (default 25) with a visible message, and "Revert this run" is a hand-rolled procedure (NOT git revert / git clean, which isomorphic-git lacks): diff checkpoint↔run-commit, checkout-force the modified/deleted paths from the checkpoint, fs.unlink the agent-created paths, then record a forward "Revert run X" commit and assert tree(C)===tree(checkpoint). External (Obsidian) concurrency is caught by re-read+hash immediately before each write, keyed to the content the write was derived from.

# G14 — Agent write-safety cluster

Applies to all four write-modes (**Synthesize, Recall, Plan, Agent**). They differ only in tool whitelist / file-scope; the safety machinery below is shared.

## 0. Terminology & invariants

- **Step** = one model→tool-call→tool-result cycle. The cap counts steps, not tool calls within a parallel batch (a batch of N tool calls = 1 step).
- **STEP_CAP** = manifest constant, **default 25**, runtime-updatable via the model manifest (ADR-0002) — never hard-coded.
- **Checkpoint A** = the pre-run commit (clean baseline). **Run-commit B** = the single commit of all approved writes. **Revert-commit C** = the forward commit that undoes B.
- **Safety invariant (load-bearing):** *no write reaches disk without an approval resolution.* The approval gate is an injected `async (proposal) => 'approve'|'reject'|'cancel-run'` callback. Consequence: a flaky local-model loop produces **rejected steps, never a corrupted vault**. This is the backstop that makes unreliable local tool-loops safe.
- **Headless boundary (ADR-0001):** the write-safety core (loop, snapshot, concurrency check, commit, revert) lives in the engine with zero Electron/DOM deps and is CLI-testable with a *scripted* approver. The UI supplies the real approval cards over IPC.
- **git binding (amended 2026-07-15, issue #27 — see the ADR-0008 amendment):** **system `git` via `execFile`** (never a shell) is the accepted v1 binding. It runs against a **dedicated checkpoint repo** (`<vault>/.cairn/checkpoints.git`, vault as work-tree) that is never the user's own `.git`, with **`core.autocrlf=false` pinned** — so the autocrlf/byte-identity hazard (feasibility report row 15) that originally motivated "isomorphic-git only; never mix with system git" no longer applies, and there is no repo-mixing. Chosen for **zero new dependencies**. If `git` is absent from `PATH`, apply refuses cleanly *before any write*. isomorphic-git (MIT) stays a noted future option if bundling/portability ever demands an in-process git — not a requirement.

## 1. Run lifecycle (the algorithm)

```
runWriteMode(mode, userGoal, approve /* injected async cb */):
  1. COMMIT CHECKPOINT A
     - stageAll(): statusMatrix → git.add every modified path, git.remove every deleted path
       (commits the user's dirty pre-run working tree so revert touches B↔A only, never
        the user's own pending edits).
     - A = git.commit({ message: `cairn: checkpoint before <mode> run <runId>` })
     - record runId, A, startTime → .cairn/runs/<runId>.jsonl (append-only)
  2. appliedPaths = new Map()   // path -> {op:'add'|'modify'|'delete', baseHash}
  3. try:
       step = 0
       loop:
         if step >= STEP_CAP:
             surface HARD-STOP message (see §2); break
         resp = model.chat(history, tools=mode.tools)   // §5 transport
         if resp has no tool calls: break   // model is done
         for each toolCall in resp:
             step += 1                         // (or: count the batch as 1 step — pick one; default: per-batch)
             if toolCall is read-only (search_notes, read_note, list_files, get_backlinks, get_pdf_annotations):
                 result = execute(toolCall); feed back; continue
             // ---- WRITE / DELETE PATH ----
             proposal = buildProposal(toolCall)  // {path, op, newContent, baseHash, diff}
             decision = await approve(proposal)  // BLOCKS; gate is the backstop
             if decision == 'reject':  feed 'rejected by user' back to model; continue
             if decision == 'cancel-run': break out of loop
             // decision == 'approve' → APPLY with concurrency check (§3)
             applyWrite(proposal, appliedPaths)  // may throw ConcurrencyAbort
             feed apply-result back to model
  4. finally:
       // ALWAYS commit whatever was approved-and-applied, even on cap-stop / error / cancel.
       if appliedPaths not empty:
           for [path, info] in appliedPaths:           // stage ONLY approved paths — never add -A
               if info.op == 'delete': git.remove({ filepath: path })
               else:                   git.add({ filepath: path })
           B = git.commit({ message: `cairn: <mode> run <runId> (<n> files)` })
           record B, endTime, stopReason → runs/<runId>.jsonl
       else:
           B = A   // no-op run; nothing to revert
```

Why two commits, not one: checkpoint A captures the **user's** dirty edits; run-commit B captures **only the agent's** approved writes. Revert operates strictly on the A→B delta, so it can never entangle the user's pre-run work. This is the central trade-off (one-commit-per-run atomicity in exchange for committing the user's dirty tree up front).

## 2. Step-25 hard-stop

- On `step >= STEP_CAP`, **terminate the loop, do not silently continue.** Surface a UI message: *"Agent reached its step limit (25). N files were written and committed; M proposals were pending. Continue, revert this run, or stop?"* Options: **[Continue +25] [Revert run] [Keep & stop]**.
- The cap is the model manifest's `agent.stepCap`; "Continue +25" extends the budget for this run only.
- Already-applied writes are committed by the `finally` block regardless — the run is always left in a single revertable commit.

## 3. Concurrency check (Obsidian-compatible vault; file may change on disk mid-run)

For every write/delete, **immediately before applying** (not at propose-time — the file can change between approval and apply):

```
applyWrite(proposal, appliedPaths):
  if proposal.op in ('modify','delete'):
     // proposal.baseHash = hash of the content the new content was DERIVED from (read earlier in the run)
     mtimeNow = fs.stat(path).mtimeMs
     if mtimeNow == proposal.readMtime: ok            // cheap mtime pre-gate (git-index style)
     else:
        hashNow = sha256(fs.read(path))
        if hashNow != proposal.baseHash:
            throw ConcurrencyAbort(path)               // external edit since we read it
  if proposal.op == 'add':
     if fs.exists(path):                               // create-collision: path appeared externally
         throw ConcurrencyAbort(path)
  // safe to write
  fs.write(path, proposal.newContent)  // or fs.unlink for delete
  appliedPaths.set(path, {op: proposal.op, baseHash: proposal.baseHash})
```

On `ConcurrencyAbort`: **do not clobber.** Abort *that step only*, surface it ("<path> changed on disk since the agent read it — skipped"), feed the failure back to the model, and continue the loop. mtime is the cheap pre-gate; the content hash is authoritative (mirrors the engine's git-index-style mtime gating).

## 4. "Revert this run" — hand-rolled procedure (THE load-bearing part)

isomorphic-git has **no porcelain `revert` and no `git clean`** (verified against the API). Both must be hand-rolled. `git.checkout` updates the working dir; `git.remove` only un-stages (does not delete the working file). So:

```
revertRun(runId):
  A = run.checkpointCommit; B = run.runCommit
  if B == A: return   // no-op run
  // 1. Authoritative change-set = diff A↔B via tree walk (NOT the run-log; log is for display only)
  changes = git.walk({ trees: [TREE({ref:A}), TREE({ref:B})], map: classify })
           // each => {path, type: 'add'|'modify'|'remove'}  (type relative to A→B)
  // 2. Restore modified + deleted paths from the checkpoint (force overwrites local changes;
  //    also recreates files the agent DELETED, because they still exist in A's tree)
  restorePaths = changes.filter(c => c.type in ('modify','remove')).map(c => c.path)
  if restorePaths.length:
      git.checkout({ ref: A, filepaths: restorePaths, noUpdateHead: true, force: true })
  // 3. Delete agent-CREATED paths (absent in A) — nothing in git removes the working file
  for c in changes where c.type == 'add':
      fs.unlink(c.path)
      git.remove({ filepath: c.path })   // drop from index too
  // 4. Re-stage restored paths so the index matches A, then commit forward (NEVER hard-reset to A —
  //    that would nuke unrelated history + any external edits since the run)
  for c in restorePaths: git.add({ filepath: c.path })   // explicit, robust regardless of checkout's index behavior
  C = git.commit({ message: `cairn: revert <mode> run <runId>` })
  // 5. ACCEPTANCE ASSERTION — byte-identical, provable:
  assert treeOid(C) === treeOid(A)   // same tree SHA ⇒ byte-identical tracked content
  if assertion fails: surface error, do NOT mark run reverted (revert is unsafe → escalate)
```

**Post-run external-edit conflict:** if the user externally edited a run-touched file *after* the run, step 2's `force:true` would clobber it. Before checkout, the revert UI must present a per-file diff for any restore-path whose on-disk hash differs from B's blob, and let the user keep-mine / take-revert per file. Never silently overwrite.

## 5. Local-model transport & the Ollama tool-streaming bug (#15497)

- **Startup capability probe** (mirror `spikes/ollama/capability.mjs`): on app launch, run a one-shot tool-call against the resident Ollama model with streaming ON. If the streamed tool-call deltas are malformed (bug #15497 on the target Ollama version), set `toolTransport = 'non-streaming-poll'` for **tool-call turns only** — plain chat streaming stays ON (the bug is specific to stream+tools).
- **Reliability tier:** for the Agent loop on small local models, prefer **grammar-constrained decoding** (node-llama-cpp GBNF) to force schema-valid tool-call JSON; also coerce/validate args server-side (the spike saw a 3B model emit `k:"1"` as a string against an integer schema). Validation + the per-step approval gate together convert flaky loops into rejected steps, not corruption.
- Transport choice is per-turn and does not change any of §1–§4.

## 6. Acceptance criteria

- Agent cannot write without an approval resolution (scripted-reject test ⇒ zero files changed, A==B).
- A reverted run restores the vault **byte-identical**: `treeOid(C) === treeOid(A)` holds for a run that adds, modifies, AND deletes files.
- Step cap stops the loop visibly; already-applied writes are still in one revertable commit.
- A file edited externally mid-run is never clobbered (ConcurrencyAbort surfaced, step skipped).

**Why.** Each piece is forced by a verified constraint, not preference. (1) isomorphic-git genuinely lacks porcelain `revert` AND `git clean` (confirmed via its API: `checkout` restores workdir, `remove` only un-stages), so revert must be the hand-rolled walk→checkout→unlink→forward-commit. (2) The two-commit model is the only way "revert the run" can avoid entangling the user's own uncommitted edits in an Obsidian-shared vault. (3) Staging only approved paths (never `add -A`) prevents a concurrent external edit from being swept into the agent's commit and reverted with it. (4) `tree(C)===tree(A)` turns the PRD/report's "byte-identical" claim into a provable assertion rather than a hope. (5) The injected async approval gate keeps the core headless per ADR-0001 and is the explicit backstop the feasibility report names for unreliable local multi-step loops. (6) The Ollama #15497 fallback is scoped to tool-call turns because the bug is stream+tools-specific, preserving chat streaming.

**Open risks / TODOs.**
- Byte-identical revert now has a testable assertion (tree(C)===tree(A)) but the hand-rolled procedure itself is unproven end-to-end — needs a spike: a run that adds+modifies+deletes files, then revert, then assert tree equality (this is the spike's pass condition).
- Post-run external edit to a run-touched file vs revert: handled by a revert-time per-file diff prompt, but the keep-mine/take-revert UX is unspecified and must be designed before Agent ships.
- Step-cap partial-run UX (Continue/Revert/Keep with pending proposals) is sketched, not finalized.
- Local multi-step (25-step) tool-loop quality is unproven beyond single-turn (spike proved 1 tool / 2-step only); GBNF + validation are the mitigation but the real failure rate on Qwen3-4B/8B is untested — gated by the v1-scope 'real 5-step run' spike.
- Whether git.checkout with filepaths updates the index for restored paths is not unambiguous in the docs; spec adds an explicit re-stage before commit C to be robust either way, guarded by the tree-equality assertion — confirm during the spike.
- Per-step vs per-batch step counting under parallel tool calls: spec defaults to per-batch; confirm against actual model behavior.

