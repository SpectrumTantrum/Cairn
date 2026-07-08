---
name: scoped-retrieval-design
description: Scoped retrieval is enforced in SQL inside the Index arms (json_each pre-filter), not by application-layer over-fetch — issue #17 relocated it.
metadata:
  type: project
---

Scoped retrieval (`scope?: string[]` include-list on `search`/`ask`/`ChatThread.send`) is enforced **in SQL inside the `Index` arms** (`vault-index.ts`), as of issue #17 (closed 2026-07-08). The `denseArm` / `ftsArm` methods take an optional `scope?: readonly string[]` and pre-filter the ranked pool *before* the top-`pool` cut, so a small scope can never be starved by out-of-scope rows ranking higher. `retrieve.ts` just normalizes the scope to forward-slash paths and threads it through; the old over-fetch (`poolForFullIndex`, `fileOf`, `scopeSet`/`keep` post-filter) is **gone**.

**How the SQL filtering works (load-bearing details):**
- Scope is passed as a *single JSON string param* and expanded with `json_each` — so an arbitrarily large include-list needs **no `IN (?,?,…)` var-chunking** and never hits SQLite's variable-number limit.
- **FTS arm:** `AND rowid IN (SELECT id FROM chunks WHERE file IN (SELECT value FROM json_each(?)))` on the `fts_chunks MATCH` query.
- **Dense arm:** sqlite-vec **0.1.9 accepts a `chunk_id IN (...)` pre-filter alongside `embedding MATCH ?`** *as long as the LIMIT/`k` is present* (verified empirically). Filters via `chunk_id IN (SELECT id FROM chunks WHERE file IN (SELECT value FROM json_each(?)))`. Still brute-force linear KNN — do NOT mislabel as ANN; this only relocated the filter, it did not change scan characteristics.
- `chunks.file` is always forward-slash (indexer does `relative(...).split(sep).join('/')`), matching the normalized scope — direct SQL equality is exact.
- `InMemoryIndex` test seam mirrors this with a `scopeFilter` predicate.
- Coverage/refusal is still computed over the *scoped* dense rows (`poolMaxCosine` from scoped `denseRows`), so refusal respects scope. `test/scope.test.mjs` passed unchanged (29/29 smoke).

**Why:** Original impl over-fetched because `vault-index.ts` was frozen by a concurrent packaging agent. That freeze lifted; issue #17 pushed scope down to SQL as the correct long-term shape (no full-pool allocation on every scoped query).

**How to apply:** The API surface (`SearchOpts.scope` semantics) is unchanged and must stay so. When touching `vault-index.ts`, preserve the asar-aware `loadVecExtension()` (rewrites `.asar/` -> `.asar.unpacked/`). This repo is worked by **parallel agents with file-ownership boundaries** (packaging agent owned `vault-index.ts`; another owns `apps/desktop/`); `git status` mixes their uncommitted changes with yours — don't assume you made edits you didn't.
