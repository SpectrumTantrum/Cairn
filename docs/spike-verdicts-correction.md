# ⚠️ Spike verdicts — correction note (2026-06-14)

**Status: provisional. Do NOT cite the spikes' PASS verdicts as ADR-grade evidence.**

An adversarial re-review (an independent Codex pass + in-repo verification) of the five
v1 build-prerequisite spikes found that **4 of 5 pass their own harness but do not
support the decision they were meant to gate** — not because the code is broken, but
because the **fixtures make the decision look safer than it is.** This note is the
warning sign while `rag-quality` is rebuilt. The canonical record (feasibility report +
ADRs + model-strategy) will be corrected *after* the rebuilt retrieval eval exists — so
we encode "here is the corrected decision," not the temporary "the old eval is bad."

## Current standing (supersedes any "validated / PASS / 95.1%" reading)

| Spike | Gated decision | Real standing |
|---|---|---|
| `rag-quality` | ADR-0002 — Qwen3-Embedding-0.6B as app-wide embedder | **PROBLEM — being rebuilt.** The eval is lexically leaky: a plain TF-IDF baseline (60/61) matched/beat Qwen3 (58/61). At n=61 that gap is ~2 questions (noise), and the corpus topics are too lexically separable, so the eval **cannot distinguish embedding quality from word-overlap.** Its "95.1% PASS" is *not* evidence the embedder is good. |
| `hybrid-sqlite` | G10 — hybrid ON by default | **PLUMBING ONLY.** Proves the sqlite-vec + FTS5 + RRF pipeline runs and recovered exactly one real exact-token miss (`useEffect`). Net-positive hybrid is unproven; the semantic-pollution guard is **structurally untestable in this corpus** (every "dense-only" gold was also returned by FTS, so RRF could never evict it). |
| `pdf-extraction` | ADR-0004 — born-digital extraction + OCR routing | **SYNTHETIC HAPPY PATH.** Column-aware sort works on a perfect in-memory PDF (clean gutter, one text item per line); OCR routing is just "zero text items → flag." Robust real-PDF extraction and real OCR routing are unproven. |
| `chunk-cache-ts` | Mneme incremental-index cost model | **MARKDOWN-BOUNDARY ONLY.** A one-paragraph Markdown edit stays cheap (proven). The heterogeneous case — PDF re-extraction reflow — got **0/16** cache hits; boundary-drift cost for non-Markdown documents is unproven (and looks bad — and heterogeneous documents are Mneme's whole reason to exist). |
| `agent-loop` | ADR-0005 — Agent mode on a local model | **USEFUL, CAVEATED.** A 4B thinking model drove the correct 5-step tool sequence 3/3. But the pass gate is lenient (validates schema + "eventually wrote a note"; no grounded-output check), and the 8B / llama3.2:3b "stalls" are **not** a model-size ordering — the 8B stall root-caused to thinking-mode empty-turn handling + tool-description phrasing (a deterministic flip), which reinforces model-strategy's existing "run Qwen3 with thinking OFF" default. |

## What changes, and when

1. **Now** — this note + a banner on the four affected spike READMEs. No canonical rewrite yet.
2. **Next** — rebuild `rag-quality` with non-leaky queries (zero/low lexical overlap with the gold), **hard same-topic distractors**, larger corpus scale, multi-gold scoring, comparing **Qwen3 dense vs TF-IDF / BM25 vs hybrid**. The goal is a regime where lexical methods *fail* so the embedder's real contribution (or lack of it) is measurable.
3. **Then** — write the corrected, durable conclusions into `cairn-feasibility-report.md`, ADR-0002 / 0004 / 0005, `docs/specs/G10-retrieval-api.md`, and `docs/model-strategy.md`.
