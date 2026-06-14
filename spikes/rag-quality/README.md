# Spike: rag-quality — does Qwen3-Embedding-0.6B clear 80% top-3 retrieval?

> ⚠️ **VERDICT UNDER REVIEW (2026-06-14):** this spike's "PASS / 95.1%" is **not ADR-grade**. The eval is lexically leaky — a plain TF-IDF baseline matched/beat Qwen3, so it can't separate embedding quality from word-overlap. **Being rebuilt.** See [`docs/spike-verdicts-correction.md`](../../docs/spike-verdicts-correction.md).

## What this proves (or breaks)

The locked stack pins **Qwen3-Embedding-0.6B (1024-dim)** as the app-wide default
embedder (ADR-0002 / model-strategy). Everything downstream — hybrid retrieval, the
"your notes don't cover this" coverage gate (G10), grounded Ask answers — assumes
this embedder can actually *find the right chunk* for a natural-language question
about the user's own notes.

This spike measures exactly that, in isolation:

> Given a fixture corpus and a set of hand-authored
> `{ question, expected_chunk_id }` pairs, does the correct chunk land in the
> **top 3** retrieved results at least **80%** of the time?

It is deliberately **index-free**: retrieval is brute-force cosine over the
fixture chunks in plain JS (same `cos()` as `spikes/ollama/capability.mjs`). That
removes sqlite-vec / FTS5 / RRF as confounding variables — this is a pure
*embedding-quality* question, not an index question. If the embedder can't rank
the right chunk into the top 3 here, no amount of index tuning saves it.

## Run it

```bash
# Prereqs: Ollama running locally + an embedder pulled (auto-detected).
ollama serve                          # if not already running (localhost:11434)
ollama pull qwen3-embedding:0.6b      # the locked model under test (1024-dim)

cd spikes/rag-quality
npm install          # no runtime deps; just initializes the lockfile
npm start            # or: node retrieval.mjs
```

The harness **auto-detects** the embedder via Ollama's `/api/tags`:

- `qwen3-embedding:0.6b` present → **LOCKED-MODEL run** (counts for the 80% bar).
- else `nomic-embed-text` present → **PROVISIONAL run** (the permitted fallback;
  proves the corpus/evals are sane but does **not** clear the locked-model bar).
- override with `EMBED_MODEL=<tag> node retrieval.mjs` (e.g. `bge-m3`).

No runtime dependencies — native `fetch`, top-level await, Node ESM. If Ollama is
unreachable, the script prints a clear skip notice and exits 0 (it does **not**
crash). A fixture desync (an eval pointing at a non-existent chunk id, or a
corpus outside 50–120 chunks) is a **real** failure and exits non-zero.

## The fixture (generated in-repo, zero manual data entry)

- `notes/*.md` — **18 short CS study notes** (sorting, complexity, graphs, trees,
  hashing, concurrency, OS, networking, DBs, DP, ML, transformers, automata,
  memory, security, caching, recursion). Deliberately **topically clustered with
  confusable neighbors** (4 sorts, 3 self-balancing trees, BFS vs DFS, chaining
  vs open addressing, LRU in caching *and* in OS paging) so top-3 is a real
  discrimination test, not a gimme.
- `chunker.mjs` — structure-aware splitter mirroring the locked chunking config
  (ADR-0006 / §G6: split by heading hierarchy, 512-token / 15% size-cap at 3.5
  chars/token). Notes are authored so every H2 section is under the cap → exactly
  **one chunk per section, 73 chunks**, deterministic boundaries. Run it directly
  (`node chunker.mjs`) to print the id manifest used when authoring evals.
  Embeds **body-only by default** (production-faithful: G5 keeps `heading_path` in
  a separate column from `chunks.text`, which is what gets embedded). Set
  `EMBED_HEADINGS=1` to prepend the heading — a confound probe, not production.
- `evals.mjs` — **61 hand-authored `{question, expected_chunk_id, category}`**
  pairs (≥ 50 target): 22 `exact-term`, 23 `paraphrase`, 16 `multi-hop`. Each
  names the **one** primary-evidence chunk; scoring is single-id membership in the
  top-3 (no "any of N" inflation). Multi-hop questions connect two ideas but still
  resolve to a single primary chunk.

Scoring is exact id membership: `expected_chunk_id ∈ top-3 retrieved ids`. The
harness guards that every `expected_chunk_id` exists and the corpus size is in
range, so re-tuning the chunker can't silently desync the evals.

## PASS / FAIL

- **PASS** — top-3 recall **>= 80%** on the **locked model** (`qwen3-embedding:0.6b`).
- **FAIL** — top-3 recall **< 80%** on the locked model → the default embedder is
  too weak for v1 retrieval; escalate (`qwen3-embedding:4b`, revisit chunking, or
  reconsider the default) before building the gate/Ask flows on top of it.
- **PROVISIONAL** — any fallback-model run is labelled provisional regardless of
  its number; it never clears or fails the bar.

## Last real run (2026-06-14, this machine — 128 GB / 18-core, NOT student hardware)

- **`qwen3-embedding:0.6b` (locked, body-only default): top-3 recall 58/61 =
  95.1% → PASS.** Per-category: exact-term 95.5%, paraphrase 95.7%, multi-hop
  93.8%. All 3 misses are chunk #67 (Merge Sort), confused with its sorting
  siblings (Timsort/Heapsort/Quicksort) — the genuine hard cluster. The corpus
  discriminates (a weaker embedder does worse, below) so this is a real margin
  over the 80% bar, not a vacuous number.
- `nomic-embed-text` (fallback, body-only): top-3 recall ~93% → PROVISIONAL — it
  misses more of the confusables, which is exactly why qwen3 is the locked default.
- **Confound check:** with `EMBED_HEADINGS=1` (heading_path prepended to the
  embedded text) qwen3 hits 61/61 = 100%. That ~5-point lift is lexical
  title-overlap, not retrieval skill — which is why the default is body-only, the
  production-faithful and more honest configuration.

> **Caveat (flagged, not corrected):** the harness embeds query and chunk
> **symmetrically** (no task-instruction prefix on the query). Qwen3-Embedding is
> trained for *asymmetric* use; a query prefix could move recall. Symmetric is
> what a naive v1 does, so this is a fair floor.

> Latency is **not** what this measures. As with the other spikes, any timings
> here would be best-case (dev hardware), not the 8–16 GB student target.
