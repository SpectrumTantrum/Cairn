# ⚠️ Spike verdicts — correction note (2026-06-14)

**Status (updated 2026-06-14): `rag-quality` RESOLVED (rebuilt + audited + written into the canonical record). The other three remain provisional — do NOT cite their PASS verdicts as ADR-grade evidence.**

An adversarial re-review (an independent Codex pass + in-repo verification) of the five
v1 build-prerequisite spikes found that **4 of 5 passed their own harness but did not
support the decision they were meant to gate** — not because the code was broken, but
because the **fixtures made the decision look safer than it was.** The retrieval crater
(`rag-quality`) has since been **rebuilt (`spikes/rag-quality-v2/`), re-measured on
human-judged BEIR, independently audited, and folded into the canonical record** (see
the table + "What changed" below). The remaining three are honestly-scoped and unhardened.

## Current standing (supersedes any "validated / PASS / 95.1%" reading)

| Spike | Gated decision | Real standing |
|---|---|---|
| `rag-quality` → **`rag-quality-v2`** | Qwen3-Embedding-0.6B as app-wide embedder (model-strategy.md; shape = ADR-0002) | **RESOLVED (2026-06-14).** Rebuilt on human-judged **BEIR** with an **independently-audited** harness (our BM25 reproduces the published BEIR baseline): Qwen3-Embedding-0.6B **beats BM25** (SciFact nDCG@10 70.4 vs 67.8, NFCorpus 36.4 vs 32.4), strongest on **low-overlap** queries; hybrid ≥ both arms. **Requires the query instruction-prefix** (without it, dense loses to BM25 on NFCorpus). Caveat: BEIR is plausibly in the embedder's training data → a Cairn-notes out-of-domain corpus is the confirmatory test. The original leaky eval is kept as a cautionary artifact. |
| `hybrid-sqlite` | G10 — hybrid ON by default | **PLUMBING ONLY** (this spike). Proves the sqlite-vec + FTS5 + RRF pipeline runs and recovered exactly one real exact-token miss (`useEffect`). Net-positive hybrid is unproven *here*; the semantic-pollution guard is **structurally untestable in this corpus** (every "dense-only" gold was also returned by FTS, so RRF could never evict it). **Update (2026-06-14):** net-positive hybrid is now **supported on real BEIR data** by `rag-quality-v2` (hybrid ≥ both arms, gains concentrated on low-overlap queries, no pollution penalty observed) — though that is document-level, not chunk-level on a Cairn vault. |
| `pdf-extraction` | ADR-0004 — born-digital extraction + OCR routing | **SYNTHETIC HAPPY PATH.** Column-aware sort works on a perfect in-memory PDF (clean gutter, one text item per line); OCR routing is just "zero text items → flag." Robust real-PDF extraction and real OCR routing are unproven. |
| `chunk-cache-ts` | Mneme incremental-index cost model | **MARKDOWN-BOUNDARY ONLY.** A one-paragraph Markdown edit stays cheap (proven). The heterogeneous case — PDF re-extraction reflow — got **0/16** cache hits; boundary-drift cost for non-Markdown documents is unproven (and looks bad — and heterogeneous documents are Mneme's whole reason to exist). |
| `agent-loop` | ADR-0005 — Agent mode on a local model | **USEFUL, CAVEATED.** A 4B thinking model drove the correct 5-step tool sequence 3/3. But the pass gate is lenient (validates schema + "eventually wrote a note"; no grounded-output check), and the 8B / llama3.2:3b "stalls" are **not** a model-size ordering — the 8B stall root-caused to thinking-mode empty-turn handling + tool-description phrasing (a deterministic flip), which reinforces model-strategy's existing "run Qwen3 with thinking OFF" default. |

## What changed, and when

1. ✅ **Done (2026-06-14)** — this note + a banner on the four affected spike READMEs + a status pointer in `v1-scope.md`.
2. ✅ **Done (2026-06-14)** — rebuilt the retrieval eval as **`spikes/rag-quality-v2/`**: non-leaky human-judged BEIR (SciFact + NFCorpus), hard same-topic distractors, multi-gold/graded scoring, **Qwen3 dense (sym + instruct) vs TF-IDF vs BM25 vs hybrid**, with a published-BM25 validity anchor and a query→gold overlap breakdown. Result: the embedder **beats BM25**, strongest on low-overlap queries; hybrid ≥ both arms. **Independently audited** (validity + leakage/fairness, both PASS, no blocking issues).
3. ✅ **Done (2026-06-14)** — durable conclusions written into `docs/model-strategy.md` (embedder validation + the load-bearing **instruction-prefix** requirement), `docs/specs/G10-retrieval-api.md` (query instruction prefix in §3; the coverage-threshold note), and `cairn-feasibility-report.md` (row 9). **ADR-0002 unchanged** — it is the model-tiering *shape*; the embedder pick lives in `model-strategy.md`.

### Still open (deliberately not closed here)
- **Cairn-specific out-of-domain notes corpus** (chunk-level): the confirmatory test before ADR-0002's embedder pick is *fully* locked — BEIR is plausibly in Qwen3-Embedding's training data.
- **`coverage_threshold` (0.5) calibration** on a Cairn corpus — the embedder's ranking is validated, the gate's absolute cosine floor is not.
- **`hybrid-sqlite`, `pdf-extraction`, `chunk-cache-ts`** remain honestly-scoped (plumbing-only / synthetic-happy-path / Markdown-boundary-only) — harden each when its decision actually gets implemented.
