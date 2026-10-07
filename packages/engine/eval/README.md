# Engine retrieval eval (`packages/engine/eval/`)

Retrieval quality for Cairn is measured on the **production `search()` path** (hybrid dense + FTS5 + RRF over a real index). This directory holds product gates and fixtures—not spike-only harnesses.

## Negative control vs real quality bars

The original **`spikes/rag-quality`** 61-question corpus is kept as a **negative control**: many “paraphrase” items still share enough stemmed tokens with the gold chunk that lexical baselines can look strong. **Do not cite the old spike’s ~95.1% top-3 number as embedding quality**; that run was [lexically leaky](../../docs/spike-verdicts-correction.md). Human-judged BEIR work lives under `spikes/rag-quality-v2/` for model comparison, but the engine product gate starts here.

## Product gate order

1. **`eval:leak` (this slice)** — `overlapCoverage` on the fixture: confirm paraphrase items are still leaky enough to invalidate naive “embedder wins” claims.
2. **Clean vault scoring (later)** — gold keyed by `(file, heading_path)` on production chunking, scored through `search()` without lexical confounds.

## Gold shape (target)

Production eval gold should reference **`(file, heading)`** (heading path within the note), not `expected_chunk_id`. The leak-check still uses the spike’s numeric ids only to locate gold chunk text in the fixture.

## Leak rule (paraphrase only)

Stemmed, stopword-stripped **query→gold token overlap** (`overlapCoverage` from `spikes/rag-quality-v2`):

| Gate | Floor |
|------|-------|
| Paraphrase **median** | ≥ 0.35 |
| Paraphrase **mean** | ≥ 0.35 |
| Paraphrase with overlap **≥ 0.25** | ≥ 70% of items |

These floors describe the **fixture’s** lexical leakiness—not a retrieval quality target. Do **not** use the overall eval median as a “HIGH overlap” bar for bucketing (live BEIR replay used ~median **0.400**, mean **0.424** for overlap bucketing).

## Commands

From `packages/engine/`:

```bash
npm run eval:leak    # negative-control leak gate (no Ollama)
# npm run eval:lexical   # planned — lexical table on production search()
# npm run eval:hybrid    # planned — full hybrid retrieval gate
```

## Layout

```
packages/engine/eval/
  README.md           # this file
  leak-check.mjs      # overlapCoverage negative control (rag-quality fixture)
```

## First engineering slice

This PR lands **README + `leak-check.mjs` + `eval:leak`**. CI should run `npm run eval:leak` after `test:smoke` once wired; that hook is a follow-up if not present yet.
