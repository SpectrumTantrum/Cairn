# Mneme spike findings (durable backup — to be merged into mneme-feasibility-report.md §Spike findings)

All spikes on this machine (macOS, 18-core / 128 GB, Python 3.13 via uv, Ollama 0.30.8). Code in `spikes/mneme/`. Each targets the load-bearing sub-claim, not the easy adjacent one.

## Spike A — chunk-hash cache: the real risk is extraction determinism, NOT the overlap cascade — `chunk_cache.py` (naive) + `chunk_cache_v2.py` (reconciled, authoritative)

**Correction:** my first pass used a naive fixed-window splitter and "proved" a 20% cascade. A workflow research agent, re-testing with the **real** LangChain `RecursiveCharacterTextSplitter` (which splits on `\n\n` first), got ~94% hits and no cascade. I re-ran with the real splitters across four regimes — the research agent is right, my naive result was an artifact. Authoritative numbers (chunk≈1800 chars ≈512 tok, 15% overlap; hash = SHA-256 of chunk *text* only, per §9):

| Regime | cache hits |
|---|---|
| A1 — structured prose + global recursive splitter + one early-section edit | **94%** (17/18) |
| A2 — structured prose + header-anchored split + same edit | **96%** (22/23) |
| A3 — run-on text (no `\n\n` near cap) + insert 5 words at start | **0%** (0/15) |
| A4 — PDF **re-extraction reflow**: identical words, lost paragraph breaks | **0%** (0/16) |

**Finding (reconciled):** the overlap-cascade fear is **overstated** — separator-respecting splitters re-anchor on paragraph breaks, so a one-paragraph edit stays contained on well-structured text (A1/A2), whether global or header-anchored. The cache truly collapses in two regimes the PRD doesn't guard: **(A3) run-on / table / OCR text** with no separators near the token cap, and — the headline case — **(A4) non-deterministic PDF re-extraction** that perturbs whitespace/reading order, which zeroes the hit-rate even when the words are unchanged. So the load-bearing risk is **extraction determinism, not chunking**. Header-anchoring is still good practice (helps A3) but does **not** fix A4. **Fixes:** (1) per-document extraction cache keyed on `file_hash` so an unchanged file is never re-extracted (PRD §16 already hints this); (2) text normalization (whitespace/Unicode) before hashing to absorb cosmetic extraction drift; (3) pin Docling versions/settings for deterministic extraction. §9 hashing text-only is correct and load-bearing.

## Spike B — bge-m3 via Ollama returns dense only, NOT sparse — `curl /api/embed`

`/api/embed` for bge-m3 returns keys `model`, `embeddings`, timing only; vector is **1024-dim dense**; **no sparse/lexical/colbert field**. The PRD's "bge-m3 via Ollama emits dense + sparse → hybrid for free" (§7/§10) is **false**. bge-m3 sparse + ColBERT need FlagEmbedding's `encode(return_sparse=True)` (Python), not Ollama. The §9 `sparse` column never populates on the Ollama path.

## Spike C — LanceDB embedded hybrid works; keyword half is FTS, not sparse — `lancedb_hybrid.py`

LanceDB **0.33.0**, embedded/on-disk/no-server. 1024-dim dense vector column + **native BM25 FTS index over `text`** (`use_tantivy=False`), then `search(query_type="hybrid").vector(qv).text(q).rerank(RRFReranker())` with citation metadata (`source_file`, `page`, `heading_path`):
- Semantic *"how do you fuse two ranked result lists?"* → top = **RRF** chunk (dense).
- Exact-term *"Kalman"* → top = **Kalman** chunk via **FTS/BM25 half**.

**Finding:** working hybrid = **dense + BM25-FTS-over-text + RRF**, embedded with citations (answers §16 open question). The keyword half is the FTS index over `text`, **not** learned-sparse vectors. With Spike B this collapses two PRD ideas: the `sparse` column and "hybrid for free from the embedder" are **both unavailable (Ollama won't emit) and unnecessary (LanceDB doesn't consume it).** Store `text`, FTS-index it, fuse with RRF.
