# PRD — Mneme: Local Multi-Format Document Indexing

> Working codename: **Mneme** (Greek muse of memory). Rename freely.
> Status: Draft v0.1 · Owner: Torres · Type: spec-first PRD (→ CLAUDE.md → implementation)

---

## 1. Problem & purpose

Cursor's codebase indexing makes a large, constantly-changing corpus semantically searchable *cheaply* — not by re-embedding everything on every change, but by detecting exactly what changed and touching only that. The expensive, clever part is the **incremental machinery**, not the RAG.

Mneme ports that machinery to **documents instead of code**, and runs **fully local** — no server, no cloud embeddings, no content leaving the machine. It indexes a folder (or folders) of heterogeneous documents — PDFs, Office files, ebooks, markdown, HTML, plaintext — watches them for changes, and serves grounded, cited semantic + keyword search over their contents.

The thing that makes this *not* "just another RAG script" is that re-indexing after an edit is near-free, and the system handles many document formats through one normalized pipeline.

### Why local
- Privacy: source documents (which may be personal, academic, or sensitive) never leave the machine.
- Cost: embeddings run on local hardware (Apple Silicon, 128GB RAM) — zero per-token cost, zero rate limits.
- Simplicity: removing the network deletes Cursor's entire encryption, path-obfuscation, and server-sync layer. "Local" is a feature, not a constraint.

---

## 2. Goals & non-goals

### Goals
1. Index a folder of mixed-format documents into a local vector store.
2. Make re-indexing after edits **incremental** — only changed documents re-processed, only genuinely-new chunks re-embedded.
3. Support **many document types** through a single normalization pipeline (see §5).
4. Serve **hybrid** (semantic + keyword) retrieval with **citations** (source file + page + heading).
5. Run entirely on-device with no external API calls in the default configuration.

### Non-goals (V1)
- Not a chat UI or RAG answer generator. Mneme is the **retrieval layer**; answer synthesis is a separate concern that consumes its output.
- Not multi-machine / team sync. Single-user, single-machine.
- Not a cross-document citation/link graph (the document analogue of "go to definition"). Deferred — see §10.
- Not real-time collaborative or networked.

---

## 3. Target users & use cases

Primary user: a developer/student maintaining a local corpus they want to search semantically — research papers, lecture notes, textbooks, personal docs, downloaded references.

Representative use cases:
- "Find the section across all my papers that discusses RRF fusion."
- "Which of my lecture PDFs covers Kalman filtering, and on what page?"
- Feeding grounded, cited chunks into a local LLM for Q&A over a personal knowledge base.
- Standalone CLI/desktop tool, or an embeddable library inside a larger app.

---

## 4. Borrowed-from-Cursor concepts (the load-bearing ideas)

Two mechanisms carry over unchanged. They are why this is "indexing" rather than "re-embed on every change."

### 4.1 Merkle tree change detection
Hash every document, then hash each directory as a function of its children's hashes, up to a single root hash. An edit to one file changes only that file's hash and the chain of parent-directory hashes to the root. To find what changed, diff the freshly-computed tree against the stored tree and walk only the branches where hashes differ.

- Cursor syncs this tree to a server. **Mneme keeps it entirely local** — the previous run's tree is persisted on disk and diffed against the current scan.
- Result: a corpus of thousands of documents costs one cheap tree walk to determine what (if anything) needs re-indexing.

### 4.2 Chunk-content-hash embedding cache
Embeddings are cached keyed by the hash of the chunk's content. After re-chunking a changed document, most chunks come out byte-identical and hit the cache; only genuinely-new chunks are embedded.

This matters **more** for documents than for code. With code, a small edit touches a few lines and you know which chunks changed. With a PDF, the file hash flips and you must re-extract and re-chunk the *whole* document — but the chunk-hash cache means you only pay to embed the parts that actually differ.

**Division of labor:**
| Layer | Question it answers |
|-------|---------------------|
| Merkle tree (file-level) | Which *documents* changed? |
| Chunk-hash cache (chunk-level) | Which *chunks* within them actually need re-embedding? |

---

## 5. Multi-format ingestion (the differentiating requirement)

Code is plaintext UTF-8 and the file *is* the text. Documents are not — they must be parsed into text **plus structure** (headings, page boundaries, reading order, tables) before anything else can happen. This is the largest new component versus Cursor.

**Design principle:** every supported format flows through a format-specific **loader** that emits one **normalized intermediate representation** — structured Markdown with a preserved heading hierarchy and positional metadata. Everything downstream (chunking, embedding, retrieval) operates only on the normalized form, so adding a new format means writing one loader, not touching the pipeline.

### 5.1 Format support matrix

| Format | Loader (V1) | Key handling | Tier |
|--------|-------------|--------------|------|
| PDF (text) | Docling / PyMuPDF | Layout-aware, page numbers, reading order, tables | V1 core |
| PDF (scanned) | Docling + OCR | OCR fallback when no text layer | V1 core |
| Markdown / `.md` | native | Already structured; parse headings directly | V1 core |
| Plaintext / `.txt` | native | No structure; chunk by paragraph/length | V1 core |
| DOCX | `python-docx` / Docling | Headings, styles, tables | V1 core |
| HTML | `unstructured` / readability | Strip nav/boilerplate, keep heading tree | V1 core |
| PPTX | `python-pptx` | Per-slide chunks, slide number as "page" | V1 stretch |
| EPUB | `ebooklib` | Chapter = heading path, spine order | V1 stretch |
| XLSX / CSV | `openpyxl` / pandas | Sheet + row metadata; row-group chunks | V2 |
| RTF | `striprtf` | Convert to text | V2 |
| Images (standalone) | OCR (Tesseract / vision) | Treat as scanned page | V2 |
| Code files | tree-sitter | Optional — full circle to Cursor's domain | V2 / opt-in |

### 5.2 Normalized intermediate representation
Each loader outputs a list of **blocks**, where a block carries:
- `text` — the block's content
- `heading_path` — e.g. `["Chapter 3", "3.2 Methods"]`
- `page` / `slide` / `location` — positional anchor for citation
- `block_type` — heading | paragraph | table | list | code | caption
- `char_span` — offset within the document

Chunking (§6) groups blocks; retrieval (§7) cites them.

---

## 6. Chunking strategy

Code splits on syntactic boundaries (AST via tree-sitter). Documents split on **structural/semantic boundaries**: heading tree → sections → paragraphs. Never split mid-table, never mid-sentence.

- After normalization to Markdown, run a **header-aware recursive splitter** with a token cap (~512 tokens, ~15% overlap). Tunable per corpus.
- Every chunk inherits and stores: `source_file`, `page`/`slide`, `heading_path`, `char_span`. This metadata **is** the citation system — the document equivalent of Cursor's file-path-plus-line-range.
- Chunk text is stored **inline** alongside its vector. No obfuscation, no re-reading source files at query time (the privacy reason Cursor reads content locally at query time doesn't apply — nothing ever leaves the machine).

---

## 7. Retrieval

The query path is a standard hybrid retrieval flow:

1. Embed the query with the **same model** used at index time.
2. Run **dense vector search** and **BM25 / sparse keyword search** in parallel.
3. Fuse results with **Reciprocal Rank Fusion (RRF)**.
4. *(Optional)* **Rerank** the top ~30 candidates with a local cross-encoder.
5. Return chunks **with citation metadata** so the caller can attribute every result.

Hybrid matters more for documents than for code: exact-term matches (names, defined terms, citations) are common, and dense-only retrieval fumbles them.

---

## 8. Architecture

Two pipelines meeting at a shared local vector store.

```
INDEX TIME (background, incremental)
  Documents → Merkle diff (changed only) → Extract + chunk (→ markdown)
            → Embed (cache-gated) → Vector store

QUERY TIME
  Query → Embed query (same model) → Hybrid search (dense + BM25 + RRF)
        → Rerank (optional) → Cited chunks (+ page, heading)

           ┌──────────────┐
  writes → │ Vector store │ ← reads
           └──────────────┘
```

---

## 9. Data model

### `documents` (Merkle layer)
| Field | Type | Notes |
|-------|------|-------|
| `doc_id` | text PK | stable id (path hash) |
| `path` | text | absolute or vault-relative path |
| `file_hash` | text | SHA-256 of file bytes (Merkle leaf) |
| `format` | text | pdf / docx / md / … |
| `last_indexed_at` | timestamp | |
| `status` | enum | indexed / pending / failed |

### `chunks`
| Field | Type | Notes |
|-------|------|-------|
| `chunk_id` | text PK | |
| `doc_id` | text FK → documents | cascade delete |
| `chunk_hash` | text | SHA-256 of chunk text → cache key |
| `text` | text | stored inline |
| `embedding` | vector | dense vector |
| `sparse` | (provider-specific) | for BM25/sparse half (if model emits it) |
| `heading_path` | text[] / json | citation |
| `page` | int | citation |
| `char_span` | int[2] | citation |

### `embedding_cache`
| Field | Type | Notes |
|-------|------|-------|
| `chunk_hash` | text PK | |
| `embedding` | vector | reused across re-index runs and across docs |

> Merkle tree itself is persisted as a serialized structure (SQLite table or JSON sidecar) holding directory→hash mappings; the `documents.file_hash` column holds the leaves.

---

## 10. Tech stack

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Embeddings | `bge-m3` via Ollama (local) | Multilingual; emits **dense + sparse** from one model → hybrid "for free." Fallbacks: `nomic-embed-text`, `mxbai-embed-large`. Keep the embedder configurable (base URL + model) per the model-agnostic principle. |
| Vector store | **LanceDB** (standalone tool) **or** pgvector (if embedded in a Supabase-backed app) | LanceDB: embedded, file-based, zero infra, disk-based indexing so the corpus needn't fit in RAM. pgvector: when it should live next to existing Postgres data. Decision per the consolidation rule. |
| Change detection | `watchdog` (Python) or `chokidar` (Node) + SHA-256 | chokidar already in use for GSD Studio. |
| Parsing | Docling (PDF-heavy), format-specific loaders otherwise | Layout-aware extraction → structured markdown. |
| Reranker (optional) | `bge-reranker-v2-m3` (local cross-encoder) | Only if retrieval quality disappoints. |
| Backend | Python (FastAPI if exposed as a service) | Consistent with stack. |

---

## 11. Incremental update flow

1. **Watcher** detects a filesystem change (or a periodic scan runs).
2. Compute the current **Merkle tree**; diff against the stored tree.
3. For each **changed** document: re-extract → re-chunk → for each chunk, look up `chunk_hash` in `embedding_cache`. Cache hit → reuse vector. Miss → embed and store. Delete the document's stale chunks first (or diff chunk sets and upsert).
4. For each **deleted** document: cascade-delete its chunks.
5. For each **new** document: full extract → chunk → embed → store.
6. Persist the new Merkle tree.

Net effect: an edit to one paragraph in one PDF re-embeds a handful of chunks, not the corpus.

---

## 12. Scope

### V1 (must build)
- Merkle-based change detection (local).
- Chunk-hash embedding cache.
- File watcher + manual re-index trigger.
- Loaders for the **V1 core** formats (§5.1): PDF text, PDF scanned (OCR), Markdown, plaintext, DOCX, HTML.
- Structure-aware chunking with citation metadata.
- Local `bge-m3` embedding, cache-gated.
- LanceDB store.
- Hybrid query (dense + BM25 + RRF) returning cited chunks via a single query function.

### Explicitly NOT in V1 (scope caps)
- **Cross-document citation/link graph** — real feature, but a V2; building it first is scope creep.
- **Reranker** — wire the interface, ship without it; add only when RRF-over-hybrid quality measurably falls short.
- **Distributed / multi-machine sync** — deleted by the "local" decision; do not reintroduce.
- **Answer generation / chat UI** — separate project; Mneme stops at returning chunks.
- V1-stretch and V2 formats (PPTX, EPUB, XLSX, CSV, RTF, images, code) — add after the core loop is proven.

### Future (V2+)
- Cross-reference graph between documents.
- Remaining formats from §5.1.
- Reranking on by default.
- Optional embeddable library packaging vs. standalone CLI.

---

## 13. Smallest concept-proving slice (V0)

Before the full V1, prove the loop end-to-end on **one format**:

> File watcher → Merkle diff → Docling extract → header-aware chunk → cache-gated `bge-m3` embed → LanceDB → one-function hybrid query.

PDF-only, no reranker, no multi-format. If incremental re-index is demonstrably cheap and queries return correctly-cited chunks, the architecture is validated and everything else is iteration.

---

## 14. Build phases (hard stops between phases)

| Phase | Deliverable | Exit criterion |
|-------|-------------|----------------|
| 0 | Repo scaffold, data model, embedder + LanceDB wired | Can embed a string and round-trip it through the store |
| 1 | Merkle tree + chunk-hash cache | Re-running on an unchanged folder does **zero** embedding calls |
| 2 | PDF loader + structure-aware chunking | A PDF indexes with correct page/heading metadata |
| 3 | Hybrid query + citations | Query returns ranked, cited chunks |
| 4 | File watcher + incremental update | Editing one file re-embeds only changed chunks |
| 5 | Remaining V1-core loaders | All core formats flow through one pipeline |
| 6 | (Optional) reranker, CLI/packaging | — |

---

## 15. Success metrics

- **Incrementality**: re-indexing an unchanged corpus → 0 embedding calls. Editing one document → embeds only its changed chunks (verifiable via cache hit/miss counts).
- **Coverage**: all V1-core formats index without manual intervention.
- **Retrieval quality**: relevant chunk in top-5 for a held-out set of queries; citations resolve to the correct page/section.
- **Locality**: zero outbound network requests in default config (verifiable by network monitor).

---

## 16. Open questions & risks

- **Chunk size tuning** — 512/15% is a starting guess; may need per-format defaults (slides vs. prose vs. tables).
- **Scanned-PDF OCR cost/quality** — OCR is slow and lossy; decide a quality bar and a per-doc timeout.
- **Sparse vector support in the store** — confirm LanceDB's hybrid/BM25 story for the chosen version, or run a separate BM25 index (e.g. Tantivy/`bm25s`) and fuse in app code.
- **Very large documents** — a 600-page PDF that changes triggers a full re-chunk; the cache softens embedding cost but extraction is still expensive. Consider per-document extraction caching keyed on `file_hash`.
- **Format edge cases** — encrypted PDFs, malformed files; loaders must fail gracefully and mark `status = failed` without halting the batch.
