# Engine retrieval eval (`packages/engine/eval/`)

Retrieval quality for Cairn is measured on the **production `search()` path** (hybrid dense + FTS5 + RRF over a real index). This directory holds product gates and fixtures—not spike-only harnesses.

## Negative control vs real quality bars

The original **`spikes/rag-quality`** 61-question corpus is kept as a **negative control**: many “paraphrase” items still share enough stemmed tokens with the gold chunk that lexical baselines can look strong. **Do not cite the old spike’s ~95.1% top-3 number as embedding quality**; that run was [lexically leaky](../../docs/spike-verdicts-correction.md). Human-judged BEIR work lives under `spikes/rag-quality-v2/` for model comparison, but the engine product gate starts here.

## Product gate order

1. **`eval:leak`** — `overlapCoverage` on the rag-quality fixture: confirm paraphrase items are still leaky enough to invalidate naive “embedder wins” claims.
2. **`eval:lexical`** — clean vault under `eval/vault/`; gold keyed by **`(file, heading)`**; scores production `search(..., { mode: "lexical" })` (FTS5 only, no Ollama).
3. **`eval:hybrid` (planned)** — same gold shape on full hybrid retrieval when Ollama (or a fake provider in CI) is available.

## Gold shape

Production eval gold references **`(file, heading)`** (heading title within the note), not `expected_chunk_id`. Any indexed chunk with that file and heading counts as relevant. The leak-check still uses the spike’s numeric ids only to locate gold chunk text in the fixture.

## Leak rule (paraphrase only, `eval:leak`)

Stemmed, stopword-stripped **query→gold token overlap** (`overlapCoverage` from `spikes/rag-quality-v2`):

| Gate | Floor |
|------|-------|
| Paraphrase **median** | ≥ 0.35 |
| Paraphrase **mean** | ≥ 0.35 |
| Paraphrase with overlap **≥ 0.25** | ≥ 70% of items |

These floors describe the **fixture’s** lexical leakiness—not a retrieval quality target. Do **not** use the overall eval median as a “HIGH overlap” bar for bucketing (live BEIR replay used ~median **0.400**, mean **0.424** for overlap bucketing).

## Paraphrase overlap ceiling (`eval:lexical`)

New paraphrase queries in `queries.json` must stay **below** overlap **0.35** vs gold chunk text (same `overlapCoverage` helper). `run-lexical.mjs` fails fast if a paraphrase is still HIGH-overlap—opposite sign from the leak gate, but the same metric.

## Lexical smoke bar (`eval:lexical`)

`npm run eval:lexical` exits **0** when:

- The harness indexes the eval vault in **lexical-only** mode and runs production lexical search without crashing.
- Paraphrase overlap checks pass.
- **At least one** `exact-term` query achieves **success@3** (gold `(file, heading)` in the top 3).

This is a minimal wiring smoke bar, not a retrieval quality SLO. The table also prints success/recall/MRR/nDCG at **k=3** and **k=8** (BEIR-style helpers from `spikes/rag-quality-v2`). Items tagged **`fts-miss`** are included in the table but are expected to fail under lexical search—they document cases hybrid search should recover later.

## Commands

From `packages/engine/`:

```bash
npm run eval:leak      # negative-control leak gate (no Ollama)
npm run eval:lexical   # clean vault, production lexical search table (no Ollama)
# npm run eval:hybrid  # planned — full hybrid retrieval gate (Ollama or test provider)
```

**CI** (`.github/workflows/ci.yml`) runs `npm run eval:leak` after `test:smoke` on macOS and Ubuntu. `eval:lexical` is local/optional for this slice until we confirm it stays fast and deterministic in CI.

## Layout

```
packages/engine/eval/
  README.md           # this file
  leak-check.mjs      # overlapCoverage negative control (rag-quality fixture)
  run-lexical.mjs     # production lexical search metrics on eval/vault
  queries.json        # gold { file, heading } per query
  vault/              # small clean Markdown corpus (notes/*.md)
```
