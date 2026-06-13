# Mneme — Feasibility Report

> Skeptical principal-engineer review of `PRD-Mneme-Local-Document-Indexing.md` (Draft v0.1).
> Mneme ports Cursor's *incremental indexing machinery* (Merkle change detection + chunk-hash embedding cache) to heterogeneous documents, fully local, as a **retrieval layer** (no chat/answer UI).
> Method: 17 assumptions researched against current sources (25 agents); risky verdicts adversarially verified; 3 highest-risk assumptions spiked with throwaway code in `spikes/mneme/`. Machine: macOS, 18-core / 128 GB.

## Verdict

**GO-WITH-CHANGES** — and the changes are *corrections, not descopes*. Mneme is a genuinely tractable build: all 17 assumptions are Feasible or Feasible-with-caveats, **none High-risk or Infeasible**, because the hard parts are off-the-shelf (Docling = one API for PDF/DOCX/HTML/PPTX/XLSX/EPUB/images; LanceDB ships embedded dense + BM25-FTS + RRF as a GA feature) and the only novel part — Merkle + chunk-hash incremental indexing — is a few hundred lines of assembly (spikes confirm). Four corrections, none adding scope: **(1)** chunk from Docling's typed-block model, *not* the lossy Markdown string §5/§6 currently route through; **(2)** delete the `sparse` column and "bge-m3 → hybrid for free via Ollama" — Ollama emits dense only and LanceDB's keyword half is its own FTS index, so sparse is *both unavailable and unnecessary* (Spikes B+C); **(3)** simplify the Merkle *tree* to a flat `{path: (hash, mtime, size)}` snapshot with mtime-gating; **(4)** if the permissive-license policy from your Cairn review carries over, drop **PyMuPDF / ebooklib / `unstructured`-extras (AGPL/copyleft)** and consolidate parsing on Docling + pypdfium2. The one real fragility is the chunk-hash cache under *non-deterministic PDF re-extraction* (not the overlap "cascade," which the spike disproved) — softened by text normalization + pinned-deterministic extraction.

## Assumptions table
🔬 = spiked. The three most design-consequential assumptions (citation-metadata, merkle-tree-vs-flat, solo-timeline) are expanded in full deep-dives below the spikes; the other fourteen are summarized in this table. All verdicts stood after adversarial verification (none refuted).

| # | Assumption | Verdict | Conf. | Library / License | Key evidence | Note |
|---|---|---|---|---|---|---|
| 1 | Merkle **tree** is the right local change-detection mechanism | Feasible-w/-caveats | High | watchdog Apache-2.0 / hashlib | [Cursor's tree exists for server-sync bandwidth](https://cursor.com/blog/secure-codebase-indexing); [local port flattens the DAG to `{path:hash}`](https://github.com/FarhanAliRaza/claude-context-local) | Over-engineered → flat `{path:(hash,mtime,size)}` + mtime-gate |
| 2 | 🔬 Chunk-hash cache makes re-index near-free | Feasible-w/-caveats | High | langchain-text-splitters MIT; Docling MIT | [recursive splitter re-anchors on `\n\n`](https://docs.langchain.com/oss/python/integrations/splitters/recursive_text_splitter); Spike A | Real risk = extraction determinism, *not* overlap cascade |
| 3 | Docling extracts all formats → structured markdown | Feasible-w/-caveats | High | Docling **MIT** | [layout-aware extraction](https://github.com/docling-project/docling); [CPU speed](https://github.com/docling-project/docling/issues/1762) | Slow on CPU (~0.6–2.5 pg/s); downloads ~500 MB models on 1st run |
| 4 | Docling + OCR handles scanned PDFs as V1-core | Feasible-w/-caveats | High | Docling + RapidOCR/EasyOCR/Tesseract (all Apache) | [EasyOCR ~13–30 s/page CPU](https://arxiv.org/pdf/2408.09869) | Make OCR an opt-in V1.x tier w/ timeout, not core |
| 5 | 🔬 bge-m3 via Ollama emits dense **+ sparse** → hybrid "free" | Feasible-w/-caveats | High | Ollama (dense only); FlagEmbedding MIT for sparse | [sparse-output request open since Aug 2024](https://github.com/ollama/ollama/issues/6230); Spike B | **False** — Ollama returns dense only |
| 6 | 🔬 LanceDB embedded hybrid (dense+BM25+RRF) w/ citations | Feasible-w/-caveats | High | LanceDB **Apache-2.0** | [hybrid = vector + FTS + RRF](https://docs.lancedb.com/search/hybrid-search); [no sparse-vector support](https://github.com/lancedb/lancedb/issues/1930); Spike C | Keyword half = FTS over `text`; the `sparse` column is unused |
| 7 | A single normalized-**Markdown** IR carries every format | Feasible-w/-caveats | High | Docling MIT / unstructured Apache | [Docling markdown export is lossy](https://github.com/docling-project/docling/discussions/1012) | Use the typed-**block** model, not a markdown string |
| 8 | Citations (file+page+heading+span) for **every** format | Feasible-w/-caveats | High | Docling MIT; **ebooklib AGPL** | [DOCX/HTML have no page provenance by design](https://github.com/docling-project/docling/discussions/997) | ⚠ `page` undefined for MD/TXT/DOCX/HTML; §9-vs-§5.2 conflict |
| 9 | Hybrid (dense+BM25+RRF) beats dense-only on documents | **Feasible** | High | LanceDB Apache / bge-m3 MIT | [Anthropic: +BM25 cut retrieval failures ~49%](https://www.anthropic.com/news/contextual-retrieval); [RRF, SIGIR'09](https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf) | RRF robust default; weighted/learned beats it with tuning |
| 10 | bge-m3 is strong enough for "top-5" retrieval | Feasible-w/-caveats | High | bge-m3 **MIT** | [8192-ctx multilingual](https://arxiv.org/html/2402.03216v3) | Not English-SOTA; top-5 gated by chunking/parsing, not the model |
| 11 | Optional bge-reranker-v2-m3 cross-encoder | Feasible-w/-caveats | High | bge-reranker-v2-m3 **Apache-2.0** | [cross-encoder +15–40% acc](https://www.sbert.net/docs/cross_encoder/pretrained_models.html) | ~0.6B model; CPU latency order-of-seconds — benchmark before default |
| 12 | §11 incremental flow (delete+reinsert, cascade) correct | Feasible-w/-caveats | High | LanceDB Apache-2.0 | [optimize after >20 modifications](https://docs.lancedb.com/indexing/reindexing) | Must `optimize()` per batch; no FKs; cache needs a GC step |
| 13 | watchdog + scan reliably detects changes | Feasible-w/-caveats | High | watchdog **Apache-2.0** | [watchers best-effort; scan reconciles](https://github.com/microsoft/vscode/wiki/File-Watcher-Issues) | Use watchdog (FSEvents on macOS); don't mix in chokidar |
| 14 | Zero outbound network in default config | Feasible-w/-caveats | High | Ollama / Docling / huggingface_hub | [Docling downloads models on 1st run](https://docling-project.github.io/docling/getting_started/rtx/) | True at steady-state; setup-time pulls need an offline-prefetch caveat |
| 15 | Parsing stack is license-clean | Feasible-w/-caveats | High | **PyMuPDF AGPL**; Docling MIT / pypdfium2 BSD | [PyMuPDF is AGPL/commercial](https://pypi.org/project/PyMuPDF/) | ⚠ AGPL: PyMuPDF, ebooklib, unstructured-extras → Docling + pypdfium2 |
| 16 | Large-doc cost bounded by file_hash extraction cache | Feasible-w/-caveats | High | Docling MIT | [600 pg ≈ 3–8 min CPU; OCR 1–2 h](https://github.com/docling-project/docling) | The file_hash extraction cache is **circular** (changed file → new hash → miss); drop/reframe it |
| 17 | 7-phase plan realistic for a solo dev | Feasible-w/-caveats | High | Docling/LanceDB/bge-m3 (permissive) | [Docling = one API for all formats](https://docling-project.github.io/docling/usage/supported_formats/) | Tractable — *far* easier than a full app (cf. Cairn) |

## Spike findings
All spikes on this machine (macOS, 18-core / 128 GB, Python 3.13 via uv, Ollama 0.30.8). Code in `spikes/mneme/`.

### Spike A — chunk-hash cache: the real risk is extraction determinism, NOT the overlap cascade — `chunk_cache.py` (naive) + `chunk_cache_v2.py` (authoritative)

**This finding was corrected mid-review.** My first pass used a naive fixed-window splitter and "proved" a 20% cascade. A workflow research agent re-tested with the *real* LangChain `RecursiveCharacterTextSplitter` (which splits on `\n\n` first) and got ~94% hits — no cascade. I re-ran with the real splitters across four regimes; the research agent is right and my naive result was an artifact. Authoritative numbers (chunk ≈1800 chars ≈512 tok, 15% overlap; hash = SHA-256 of chunk *text* only, per §9):

| Regime | cache hits |
|---|---|
| A1 — structured prose + **global** recursive splitter + one early-section edit | **94%** (17/18) |
| A2 — structured prose + **header-anchored** split + same edit | **96%** (22/23) |
| A3 — run-on text (no `\n\n` near cap) + insert 5 words at start | **0%** (0/15) |
| A4 — **PDF re-extraction reflow**: identical words, paragraph breaks lost | **0%** (0/16) |

**Finding:** the overlap-cascade fear is **overstated** — separator-respecting splitters re-anchor on paragraph breaks, so a one-paragraph edit stays contained on well-structured text (A1/A2), whether global or header-anchored. The cache truly collapses in two regimes the PRD doesn't guard: **(A3) run-on / table / OCR text** with no separators near the cap, and — the headline case — **(A4) non-deterministic PDF re-extraction** that perturbs whitespace/reading order, which zeroes the hit-rate *even when the words are unchanged*. (A4's 0% is the *worst case where extraction is perturbed*, not "PDFs get 0%": an unchanged file is skipped by Merkle entirely, and a deterministic extractor re-extracts unchanged regions byte-identically — so A4 bites on reflow-on-edit, OCR, and Docling version/setting drift specifically.) So the load-bearing risk is **extraction determinism, not chunking**. Header-anchoring is still good practice (helps A3) but does **not** fix A4. **Fixes:** (1) text normalization (whitespace/Unicode) before hashing to absorb cosmetic reflow; (2) pin Docling versions/settings for deterministic extraction; (3) the §16 "per-document extraction cache keyed on file_hash" does *not* help here (a changed file has a new hash → miss). §9's choice to hash text-only is correct and load-bearing.

### Spike B — bge-m3 via Ollama returns dense only, NOT sparse — `curl /api/embed`

`/api/embed` for `bge-m3` returns keys `model`, `embeddings`, and timing only; the vector is **1024-dim dense** with **no sparse/lexical/colbert field**. **Finding:** the PRD's "bge-m3 via Ollama emits dense + sparse → hybrid for free" (§7/§10) is **false** — Ollama serves only the pooled dense vector (the sparse-output feature request has been [open since Aug 2024](https://github.com/ollama/ollama/issues/6230)). bge-m3's sparse + ColBERT outputs require FlagEmbedding's `encode(return_sparse=True)` (Python lib), which Ollama does not run. So the §9 `sparse` column "if the model emits it" never populates on the Ollama path.

### Spike C — LanceDB embedded hybrid works; the keyword half is FTS, not sparse — `spikes/mneme/lancedb_hybrid.py`

LanceDB **0.33.0**, embedded/on-disk/no-server. Created a 1024-dim dense vector column + a **native BM25 full-text index over the `text` column** (`use_tantivy=False`, no extra dep), then ran `search(query_type="hybrid").vector(qv).text(q).rerank(RRFReranker())` with citation metadata (`source_file`, `page`, `heading_path`) on every row:
- Semantic *"how do you fuse two ranked result lists?"* → top result is the **RRF** chunk (dense match).
- Exact-term *"Kalman"* → top result is the **Kalman** chunk, surfaced by the **FTS/BM25 half** (a one-word query dense-embeds weakly).

**Finding:** the working hybrid path is **dense + BM25-FTS-over-text + RRF**, fully embedded with citations — which cleanly answers the §16 open question. Critically, **the keyword half comes from LanceDB's FTS index over the stored `text`, not from any learned-sparse vector** ([sparse-vector support is an open feature request](https://github.com/lancedb/lancedb/issues/1930)). Combined with Spike B this collapses two PRD ideas at once: the `sparse` column and "hybrid for free from the embedder" are **both unavailable (Ollama won't emit) and unnecessary (LanceDB doesn't consume it).** Just store `text`, FTS-index it, and fuse with RRF.

## Assumption — Citation metadata (source_file + page + heading_path + char_span) [key: citation-metadata]
Verdict: **Feasible-with-caveats** (Conf: High). Docling = MIT (permissive, no flag).

What is solidly TRUE:
- Docling's `ProvenanceItem` exposes `page_no` (int), `bbox`, and `charspan` ([start,end], 0-indexed). HybridChunker carries this per chunk via `chunk.meta.doc_items[].prov[]` plus `chunk.meta.headings` (the heading path). For **PDF**, page + heading + char span resolve correctly. (docling-core DoclingDocument.json schema; hybrid chunking docs.)

What BREAKS the blanket "for every format" claim:
1. **Of the six V1-core formats, only PDF has a real page.** V1-core (§12) = PDF-text, PDF-scanned, MD, TXT, DOCX, HTML — only the two PDF variants carry genuine page provenance; MD/TXT/DOCX/HTML do not. Maintainer simonschoe (#997, 2025-04-01): ".docx files do not track [bbox/page] information." Maintainer vagenas (#1012, 2025-05-14): prov is available "where a stable paging & in-page rendering is given (PDF)"; "Formats like HTML do not have any such strong concept"; for DOCX "there is no strong guarantee about their paging or rendering, so we cannot have a reliable prov." For these formats Docling leaves `prov` **empty**. (EPUB — V1-stretch — is reflowable and likewise page-less.)
2. **Internal PRD inconsistency: §5.2 (flexible anchor) vs §9 (`page int`).** In ProvenanceItem, `page_no`/`bbox`/`charspan` are ALL `required` — so non-paged formats produce NO ProvenanceItem at all (not a page-less one). §9 hard-codes `page int` present for every chunk, yet that is undefined for 4 of 6 V1-core formats. §5.2 already models the anchor flexibly ("`page` / `slide` / `location` — positional anchor"), so the defect is the §9/§5.2 mismatch — the field must be nullable or carry a per-format anchor (slide#/section ordinal/block index). The PRD half-anticipated this, which is why this is a caveat, not a blocker.
3. **`char_span` semantic mismatch.** PRD §5.2/§9 define `char_span` as "offset within the document." Docling `charspan` (confirmed in the schema) is per-item — offsets within that item's own text. A document-global offset must be reconstructed by the app; it is not free from Docling.

Net: PDF citations are genuinely reliable. The success-metric phrasing "citations resolve to the correct page/section *for every format*" is not achievable as stated, because page is undefined for MD/TXT/DOCX/HTML. Fixes are tractable and partly pre-figured by §5.2 (nullable page + per-format anchor; reconstruct global char offset). PITFALL (implementation, not PRD-as-written): if the §5.2 normalized IR is persisted/re-parsed as a *markdown string*, Docling provenance is lost — Markdown/HTML export is lossy (vagenas, #1012). Keep the in-memory DoclingDocument or its lossless JSON and chunk from that.

## Assumption — Merkle TREE is the right local change-detection mechanism [key: merkle-tree-vs-flat] (PRD §4.1/§9/§11)
Verdict: **Feasible-with-caveats** (Conf: High). `watchdog` Apache-2.0 / `chokidar` MIT / stdlib `hashlib` — no AGPL/GPL. licenseFlag = false.

Claim under test: "A Merkle TREE (hierarchical dir hashes to a root) is the right local change-detection mechanism — diff fresh tree vs stored tree, walk only differing branches." Finding: the tree WORKS but is over-engineered for a local single-machine tool; the right shape is a flat `{path: (file_hash, mtime, size)}` snapshot diff. Not a blocker — a simplification.

Why the tree is right for Cursor but not Mneme:
- Cursor's own blog says the tree exists to avoid re-sending data to a SERVER: "In a workspace with fifty thousand files, just the filenames and SHA-256 hashes add up to roughly 3.2 MB. Without the tree, you would move that data on every update. With the tree, Cursor walks only the branches where hashes differ." (cursor.com/blog/secure-codebase-indexing). Client and server EACH hold a tree and compare every ~5 min (TDS deep-dive). The pruning payoff = not transmitting unchanged-subtree hashes over the wire. Mneme deletes the network (PRD §1), deleting the tree's reason to exist.
- The leading OSS LOCAL port of this exact design, `claude-context-local` (Claude Code MCP, local embeddings), builds a hierarchical "Merkle DAG" (`hash_directory()` folds child hashes) but its change detection (`change_detector.py`) FLATTENS the DAG to `{path: hash}` via `get_file_hashes()` and does set-difference on path keys: `added = new_paths - old_paths`; `removed = old_paths - new_paths`; `if old_files[path] != new_files[path]: modified.append(path)`. The directory hashes are computed and NEVER used for the diff. Direct proof that locally the tree collapses to a flat-map diff. (github.com/FarhanAliRaza/claude-context-local: merkle/merkle_dag.py, merkle/change_detector.py)

The real optimization the PRD misses:
- Neither Cursor's blog nor the local port uses mtime gating — both re-read+re-hash every file each scan (`while chunk := f.read(8192): sha256.update(chunk)`). For a re-hash-every-scan local tool the dominant cost is reading bytes (disk-I/O bound). The PRD itself flags the worst case (§16: 600-page PDF re-chunk; "Consider per-document extraction caching keyed on file_hash") yet still re-reads unchanged files.
- The proven local pattern is Git's index: cache (mtime,size) per file and skip reading content when stat is unchanged — Git "avoid[s] examining file contents to determine if a file has been modified by looking at its stats only" (git-scm.com/docs/racy-git). This is orthogonal to and strictly more impactful than directory-hash pruning: it removes I/O entirely for unchanged files, whereas dir hashes only save CPU comparisons over an already-O(n)-cheap flat dict. (Mind the "racy-git" mtime-granularity edge case — re-hash when stat == snapshot timestamp.)
- `watchdog` (PRD §10) makes the periodic full scan a cold-start/safety-net path, not the hot path: create/modify/delete events arrive directly (pypi.org/project/watchdog).

Net at PRD §3 scale ("thousands of documents"): a flat `dict[path] = (file_hash, mtime, size)` persisted in the `documents` table Mneme ALREADY defines (§9 has `path`+`file_hash`) + set-diff is fewer LOC, needs no serialized-tree sidecar (§9 note proposes a JSON/SQLite tree blob — unnecessary), and with an mtime/size pre-check is *faster* than re-hashing. Keep "Merkle" vocabulary for lineage if desired; implement a flat snapshot diff. Reserve true directory-hash pruning only if a corpus reaches 10^5–10^6 files (out of PRD scope).

## Assumption — 7-phase build plan (V0→V1) is realistic for a solo dev [key: solo-timeline-mneme] (PRD §13/§14)
Verdict: **Feasible-with-caveats** (Conf: High). Small because libraries do the heavy lifting and the plan is properly sliced into 7 vertical slices, each with a binary exit criterion. Far more favorable than a full app — no UI/chat/agent, no packaging-for-3-OS, retrieval-only, Python.

- **Phase 5 collapses.** Docling (MIT; IBM Research, now Linux Foundation; open-sourced Jul 2024, weekly releases since) converts PDF/DOCX/PPTX/XLSX/EPUB/HTML/Markdown/CSV/images into ONE unified DoclingDocument via a single `DocumentConverter` API, with native OCR (Tesseract/EasyOCR/RapidOCR) for scanned PDFs. "Remaining V1-core loaders" = format dispatch + trivial .txt, not 6 hand-written parsers. https://docling-project.github.io/docling/usage/supported_formats/
- **Phase 3 is off-the-shelf (proven by Spike C).** LanceDB (Apache-2.0) does dense+BM25-FTS+RRF hybrid as a production/GA feature; Spike C runs it embedded with citation metadata. Not invented code. https://docs.lancedb.com/search/hybrid-search
- **The "novel" part is assembly, not research.** Merkle + content-hash embedding cache for documents has few direct comparables, but incremental-by-content-hash is a mature, documented 2025-26 pattern (LlamaIndex incremental updates; CocoIndex memoizes by hash(input)+hash(code); DEV guides use SHA-256 file-hash + debounced watcher). Spike A shows the cache core is a few hundred lines.
- **Effort anchor.** txtai (Apache-2.0, NeuML/solo-origin) ~1928 commits / 12.7k stars — but that is the FULL all-in-one framework (LLM orchestration, agents, pipelines, JS/Java/Rust/Go bindings). Mneme is far narrower, so the comparable subset is much smaller.

### Caveats (none blocking)
- Effort is uneven: Phase 2 (structure-aware chunking + mapping citation metadata out of DoclingDocument) is the real bulk of bespoke work.
- Scanned-PDF OCR is the speed/quality wildcard (EasyOCR ~30s/page on CPU; §16 already flags it). Needs per-doc timeout + quality bar.
- Spike A (reconciled): the overlap "cascade" is overstated — separator-respecting splitters re-anchor on `\n\n`, so a one-paragraph edit stays ~94–96% cache-hit on structured prose. The real cache-killer is non-deterministic PDF *re-extraction* (0% hits on reflowed-but-identical text) — a Phase-2/extraction-determinism concern, not the timeline.
- Spike B (done): bge-m3 via Ollama returns dense only (no sparse); and Spike C proved the BM25 half comes from LanceDB's FTS over stored text, so hybrid never depended on model-emitted sparse. Neither gates the timeline.

### License (carry forward sibling audit; not re-litigated)
Core machinery permissive: LanceDB Apache-2.0, Docling MIT, bge-m3 MIT, watchdog Apache-2.0, Tantivy MIT. licenseFlag = TRUE only because the PRD-as-written still names PyMuPDF (AGPL-3.0/commercial) and ebooklib (AGPL-3.0). Both avoidable at ZERO timeline cost (Docling's pypdfium2 backend is BSD/Apache; EPUB via Docling or zipfile+lxml).

## Blockers & alternatives

**There are no blockers** — nothing is High-risk or Infeasible. What follows are the load-bearing corrections (each with the fix and why) and the one license flag with its alternative.

### C1 — Chunk from Docling's typed-block model, not the Markdown string (Assumptions 7, 8)
**Problem:** §5/§6 route every format through a "normalized intermediate representation — structured **Markdown**" and chunk from that. Docling's Markdown/HTML export is explicitly **lossy** — it drops the page/bbox provenance the citation system depends on. The PRD conflates two different IRs: a *typed block list* (§5.2, the object model) vs. a *markdown string* (§5/§6 prose). **Fix:** keep the in-memory `DoclingDocument` (or its lossless JSON) as the IR and chunk with Docling's `HybridChunker`, which carries `page`, `bbox`, `charspan`, and `heading_path` per chunk. Never persist-and-re-parse a markdown string. Zero added scope — it's a smaller pipeline.

### C2 — Delete the `sparse` column and "hybrid for free from the embedder" (Assumptions 5, 6 — Spikes B+C)
**Problem:** the data model's `sparse` column and the "bge-m3 via Ollama → dense+sparse" idea are **both unavailable** (Ollama returns dense only — Spike B) **and unnecessary** (LanceDB's keyword half is its FTS/BM25 index over `text`, and it has no sparse-vector support — Spike C). **Fix:** drop the `sparse` column; store `text`, build a LanceDB FTS index, fuse dense + FTS with RRF. *If* you ever want true learned-sparse (SPLADE/bge-m3 sparse), that requires FlagEmbedding (Python, MIT) for encoding **and** a store that consumes sparse vectors (LanceDB doesn't) — a V2 decision, not V1.

### C3 — Simplify the Merkle *tree* to a flat mtime+hash snapshot (Assumption 1 — see deep-dive)
**Problem:** the hierarchical tree exists to minimize Cursor's **client→server** sync bandwidth; Mneme has no server. The leading local port (`claude-context-local`) builds the DAG but its change detector flattens it to `{path: hash}` and never uses the directory hashes. **Fix:** a flat `{path: (file_hash, mtime, size)}` snapshot diff (the `documents` table already holds path + file_hash) plus **Git-index-style mtime/size gating** to skip re-reading unchanged files — which the tree does *not* provide and which is the real I/O win. Drop the serialized-tree sidecar. Reserve true directory-hash pruning for 10⁵–10⁶ files (out of scope).

### C4 — License flag: drop PyMuPDF / ebooklib / `unstructured`-extras → consolidate on Docling + pypdfium2 (Assumptions 2, 8, 15)
**Problem:** the PRD names **PyMuPDF (AGPL-3.0 / commercial)** for PDFs and **ebooklib (AGPL-3.0)** for EPUB; `unstructured` is Apache in name but its extras pull AGPL (`ultralytics`) and LGPL (`chardet`). This PRD states *no* license policy, but the sibling Cairn review enforced permissive-only — **if that carries over, these are flags.** **Fix (zero cost):** Docling is **MIT** and does **not** depend on PyMuPDF — its PDF backend is **pypdfium2 (BSD/Apache)** + docling-parse (MIT), and it handles HTML and EPUB too. Consolidating the entire parsing layer on Docling removes all three copyleft deps without a redesign. (If you keep a fast text-only path, **pypdfium2** or **pypdf (BSD)** replace PyMuPDF.)

### Lower-severity caveats (engineering, not blockers)
- **Extraction determinism is the real cache risk (Spike A):** normalize text before hashing and pin Docling settings; the §16 file_hash *extraction* cache is circular (changed file → new hash → miss) — drop or reframe it.
- **OCR is not "core":** EasyOCR ~13–30 s/page on CPU and lossy on degraded scans — make scanned-PDF a V1.x opt-in tier with a per-doc timeout + stated quality bar.
- **LanceDB incremental hygiene:** FTS/ANN indexes aren't auto-incremental; delete-then-reinsert is 2 ops/doc so you trip LanceDB's ">20 modifications" rule fast — run `optimize()` per batch; add a GC for orphaned `embedding_cache` rows; "cascade delete" is an app-issued `DELETE WHERE doc_id=…` (no FKs).
- **Citation `page` (Assumption 8):** make `page` nullable + add a per-format anchor (slide#/section-ordinal/block-index); page is undefined for MD/TXT/DOCX/HTML.
- **"Zero outbound" (Assumption 14):** true at steady-state, but first-run pulls models (Ollama registry + Docling/HF) and macOS Ollama auto-updates — pre-bundle/prefetch and document a setup-vs-steady-state distinction so a network monitor matches the claim.

## Revised recommendation

**Build it.** Unlike the sibling Cairn review (where the headline problem was a 3–6× timeline overrun), Mneme's scope is right-sized: retrieval-only, Python, no UI/agent/packaging, and the two hardest subsystems are off-the-shelf and spike-verified. Apply the four corrections above — all of which *simplify* the design — and keep the rest of the PRD as written. Concrete build guidance:

1. **V0 slice is the right call** (§13): PDF-only, watcher → flat-snapshot diff → Docling extract → `HybridChunker` (carry provenance) → cache-gated bge-m3 dense → LanceDB → one-function hybrid (dense + FTS + RRF). Prove cheap incremental re-index + correct citations, then iterate.
2. **Fold the corrections in from the start** (they're cheaper now than later): block-IR not markdown-string; no `sparse` column; flat mtime+hash; Docling+pypdfium2 only.
3. **Phase-2 is the real work** (structure-aware chunking + mapping Docling provenance to citations) — budget accordingly; everything else is wiring.
4. **Validate empirically, don't assume:** the "relevant chunk in top-5" and OCR quality bars need a held-out query set and a real-document re-extraction test (the one residual the headless spikes couldn't cover).
5. **Defer cleanly:** reranker (wire the interface, off by default), scanned-PDF OCR (opt-in tier), and any learned-sparse/SPLADE ambition (V2, needs a different store).

**Net:** GO-WITH-CHANGES with high confidence. The corrections remove complexity and one license exposure; none cut a feature.

## Sources

Primary sources, deduped and grouped (119 unique URLs gathered across the workflow; load-bearing ones here, the rest reproducible from per-assumption evidence).

**Borrowed-from-Cursor mechanics:** [Cursor: secure codebase indexing (Merkle = server-sync)](https://cursor.com/blog/secure-codebase-indexing) · [How Cursor indexes your codebase](https://towardsdatascience.com/how-cursor-actually-indexes-your-codebase/) · [claude-context-local (local port flattens the DAG)](https://github.com/FarhanAliRaza/claude-context-local) · [Git racy-git (mtime/size gating)](https://git-scm.com/docs/racy-git/2.5.6)

**Chunking / cache:** [LangChain RecursiveCharacterTextSplitter](https://docs.langchain.com/oss/python/integrations/splitters/recursive_text_splitter) · [LangChain CacheBackedEmbeddings](https://python.langchain.com/api_reference/langchain/embeddings/langchain.embeddings.cache.CacheBackedEmbeddings.html) · [CocoIndex (memoize by hash)](https://github.com/cocoindex-io/cocoindex)

**Docling (extraction / OCR / provenance / IR):** [Docling repo (MIT)](https://github.com/docling-project/docling) · [Docling tech report (arXiv)](https://arxiv.org/pdf/2408.09869) · [supported formats](https://docling-project.github.io/docling/usage/supported_formats/) · [chunking / HybridChunker](https://docling-project.github.io/docling/concepts/chunking/) · [DoclingDocument provenance](https://docling-project.github.io/docling/concepts/docling_document/) · [#997 DOCX has no page info](https://github.com/docling-project/docling/discussions/997) · [#1012 markdown export is lossy](https://github.com/docling-project/docling/discussions/1012) · [LICENSE (MIT)](https://github.com/docling-project/docling/blob/main/LICENSE)

**Embeddings / reranker / Ollama:** [bge-m3 (MIT, 8192 ctx)](https://huggingface.co/BAAI/bge-m3) · [bge-m3 paper (arXiv 2402.03216)](https://arxiv.org/html/2402.03216v3) · [bge-reranker-v2-m3 (Apache-2.0)](https://huggingface.co/BAAI/bge-reranker-v2-m3) · [Ollama embed = dense only; sparse request #6230](https://github.com/ollama/ollama/issues/6230) · [Ollama bge-m3 library](https://ollama.com/library/bge-m3) · [FlagEmbedding (MIT, sparse/ColBERT path)](https://raw.githubusercontent.com/FlagOpen/FlagEmbedding/master/LICENSE) · [cross-encoder gains (SBERT)](https://www.sbert.net/docs/cross_encoder/pretrained_models.html)

**Vector store / hybrid / RRF:** [LanceDB hybrid search](https://docs.lancedb.com/search/hybrid-search) · [LanceDB full-text search](https://docs.lancedb.com/search/full-text-search) · [reindexing / optimize cadence](https://docs.lancedb.com/indexing/reindexing) · [no sparse-vector support (#1930)](https://github.com/lancedb/lancedb/issues/1930) · [LanceDB LICENSE (Apache-2.0)](https://github.com/lancedb/lancedb/blob/main/LICENSE) · [RRF — Cormack et al., SIGIR'09](https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf) · [Anthropic Contextual Retrieval (BM25 + dense)](https://www.anthropic.com/news/contextual-retrieval) · [Tantivy](https://github.com/quickwit-oss/tantivy)

**Watcher / licenses:** [watchdog (Apache-2.0)](https://pypi.org/project/watchdog/) · [VS Code file-watcher caveats](https://github.com/microsoft/vscode/wiki/File-Watcher-Issues) · [PyMuPDF (AGPL/commercial)](https://pypi.org/project/PyMuPDF/) · [pypdfium2 (BSD/Apache)](https://github.com/pypdfium2-team/pypdfium2) · [ebooklib (AGPL-3.0)](https://github.com/aerkalov/ebooklib/blob/master/setup.py) · [unstructured LICENSE](https://github.com/Unstructured-IO/unstructured/blob/main/LICENSE.md) · [pypdf (BSD)](https://github.com/py-pdf/pypdf)
