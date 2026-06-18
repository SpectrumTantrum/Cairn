# Spike: rag-quality-v2 — does Qwen3-Embedding-0.6B actually beat lexical retrieval?

Replaces the original [`rag-quality`](../rag-quality/) spike, whose hand-authored eval
was lexically leaky: a TF-IDF baseline tied/beat the embedder because the corpus topics
were too separable, so the test couldn't tell embedding quality from word-overlap. See
[`docs/spike-verdicts-correction.md`](../../docs/spike-verdicts-correction.md).

## What this proves (or breaks)

ADR-0002 pins **Qwen3-Embedding-0.6B** as Cairn's app-wide embedder. That is only
justified if the embedder **earns its place over pure lexical retrieval** — especially
on low-overlap (paraphrase / intent) queries, which is exactly where a bag-of-words
baseline should fail and a real embedder should win.

This eval removes the authoring bias that broke v1 by running on **human-judged BEIR
benchmarks** — the queries and relevance labels are external, so we can't accidentally
write a leaky test:

- **SciFact** — scientific claims → supporting/refuting abstracts; claims are genuine
  paraphrases of the evidence (low lexical overlap by construction).
- **NFCorpus** — natural-language health questions → relevant docs; **multi-gold,
  graded relevance**, and famously hard for dense models to beat BM25 (a fair, even
  adversarial, test).

It compares, at the document level (standard BEIR protocol):

| Method | What it is |
|---|---|
| `tfidf` | TF-IDF cosine — lexical baseline (continuity with the original spike's number) |
| `bm25` | BM25 (k1=0.9, b=0.4, Anserini/BEIR defaults) — the real lexical baseline; matches G10's FTS5 keyword arm |
| `dense-sym` | Qwen3-Embedding, query embedded **symmetrically** (what a naive v1 does) |
| `dense-instruct` | Qwen3-Embedding with its **trained query-instruction prefix** (the fair test of the embedder) |
| `hybrid(d+bm25)` | `dense-instruct` + `bm25` fused with **RRF (K=60)** — matches G10 |

Metrics: **nDCG@10** (primary, comparable to literature), Recall@3/@10, MRR@10,
Success@1 — and the same metrics **bucketed by query→gold lexical overlap** so we see
*where* the embedder wins (the decisive view the old spike lacked).

**Validity anchor:** the run prints our BM25 nDCG@10 next to the published BEIR number
(SciFact ≈ 0.665, NFCorpus ≈ 0.325). If they're close, the harness is sound; if our
BM25 is far off, the implementation is buggy and no other number can be trusted.

## Run

```bash
cd spikes/rag-quality-v2
npm run fetch     # downloads SciFact + NFCorpus (BEIR) into ./data (not committed)
npm start         # both datasets;  or: npm run scifact / npm run nfcorpus
# MAX_DOCS=500 MAX_Q=20 node run.mjs scifact   # fast smoke test (numbers meaningless)
```

Prereqs: Node ≥ 23.6, Ollama on `localhost:11434` with `qwen3-embedding:0.6b`.
Embeddings are cached under `data/cache/` after the first run.

## Decision rule (replaces the dead "≥80% top-3" bar)

Qwen3-Embedding-0.6B is justified as the app-wide embedder **iff `dense-instruct`
materially beats BM25** (overall, and especially on LOW-overlap queries) **or `hybrid`
materially beats both arms.** If BM25 ≈ dense, that is itself a finding — lean
lexical-first / hybrid and reconsider the embedder default before it's locked.

## Caveats (honest scope)

- Document-level retrieval (BEIR protocol), not chunk-level — the chunk-level + Cairn-
  notes realism is a deliberate follow-up (the planned Cairn-specific corpus).
- BM25/TF-IDF use Porter stemming + stopwords (fair baseline); no learned sparse.
- Generic scientific/health domains, not personal study notes — see the follow-up.
