# Spike: TS per-chunk embedding cache — does an edit stay cheap?

> ⚠️ **VERDICT UNDER REVIEW (2026-06-14):** this spike's PASS covers **Markdown paragraph edits only**. The heterogeneous case (PDF re-extraction reflow) got **0/16** cache hits — boundary-drift cost for non-Markdown documents is unproven. See [`docs/spike-verdicts-correction.md`](../../docs/spike-verdicts-correction.md).

**Status: DONE.** The harness, the cache, the test corpus, and the load-bearing
separator-respecting recursive chunker are all implemented and runnable. It
prints a real PASS/FAIL and exits with that status (0 = PASS, 1 = FAIL).

## What this proves

TS port of the idea in `spikes/mneme/chunk_cache.py` (+ `chunk_cache_v2.py`), now
that the engine is TS (ADR-0001). The locked embedding cache is keyed on
`(chunk_hash, embedder_id, dimension)`, where `chunk_hash = SHA-256` of the
**normalized** chunk text (G6/G7: collapse whitespace + NFC + LF before hashing).

The claim under test: **re-embedding cost is bounded to the edit.** We chunk a
markdown doc (512-tok target / 15% overlap, separator-respecting), hash each
chunk, warm the cache, then re-index after two perturbations and count how many
chunk_hashes survive (a hit = a vector we don't recompute):

- **(a) one paragraph rewritten mid-document** (Section 2 of 12) — the headline
  cheap-edit case. **This is the PASS bar.**
- **(b) PDF re-extraction reflow** (same words, paragraph breaks collapsed to
  single spaces) — diagnostic only; this is Spike A4, the extraction-determinism
  risk, which the Python spike zeroed out. **Not part of the PASS bar.**

**No model is called.** Hit-rate is a `chunk_hash` multiset comparison over text;
`embedder_id`/`dimension` are an inert label on the cache key (identical in
`warm()` and `reindex()`, they cancel out). So there is **no Ollama / no embedder
prerequisite** — it runs fully offline.

## Run

```bash
cd spikes/chunk-cache-ts && npm install && npm start
```

`npm install` is required (one MIT dependency, `@langchain/textsplitters` — see
below). Node (>= 23.6, e.g. v24) then runs the `.ts` file directly via native
type-stripping — no build step. (`npm start` is just `node hitRate.ts`.)

## PASS / FAIL

**PASS = scenario (a), the one-paragraph markdown edit, yields ≥ 80% cache hits.**
The script prints the hit-rate for each scenario, a final `PASS`/`FAIL` line, and
`process.exit`s with 0 (PASS) or 1 (FAIL).

### Real result (Node v24, `@langchain/textsplitters@1.0.1`)

```
== (a) one-paragraph markdown edit (mid-doc, Section 2 of 12) ==
  md edit: 18 -> 18 chunks  |  HITS 17/18 (94%)  |  re-embeds 1
== (b) PDF re-extraction reflow (same words, paragraph breaks lost) ==
  reflow: 18 -> 16 chunks  |  HITS 0/16 (0%)  |  re-embeds 16
-- verdict --
(a) one-paragraph markdown edit: 94% hits -> PASS (bar: >=80%)
(b) PDF re-extraction reflow: 0% hits [DIAGNOSTIC, not a pass bar] -> normalization does NOT rescue a lost \n\n (A4 stands)
```

**(a) PASS at 94%** — re-anchoring on `\n\n` contains the edit to a single chunk
(1 re-embed out of 18). This reproduces the Python `chunk_cache_v2.py` A1 ~94%
result: the TS path uses the same `RecursiveCharacterTextSplitter`, configured to
G6, so the measured cache-hit evidence carries over rather than being re-derived
from a hand-rolled port. (The PASS bar is ≥80%; 94% clears it with margin.)

**(b) 0%, as expected and as designed.** A reflow turns every `\n\n` into a single
space; a lost paragraph break is then indistinguishable from an intra-paragraph
space, so `normalize()` (which only *collapses* whitespace, it cannot *restore* a
break) cannot rescue it — every boundary shifts and the whole doc re-embeds. This
matches Python A4 = 0%. **The honest finding: pre-hash normalization absorbs
cosmetic whitespace drift but does NOT rescue full paragraph-break loss.** That is
why G7's real A4 defense is the *pinned PDF-extraction cache* (re-chunk from cached
deterministic text), not normalization alone — see `docs/engineering-decisions.md`
§G7 and the open determinism spike noted there for the pdf.js extractor.

## The chunker

`@langchain/textsplitters`' `RecursiveCharacterTextSplitter` (MIT — full
dependency tree audited, all 13 transitive packages MIT, no AGPL/GPL/LGPL),
configured exactly to G6:

```ts
new RecursiveCharacterTextSplitter({
  chunkSize: 1792,            // ~512 tok at 3.5 chars/tok (one pinned length fn)
  chunkOverlap: 269,          // 15%
  separators: ["\n\n", "\n", ". ", " ", ""],
})
```

This is the same splitter the Spike-A numbers were measured against, configured to
G6, so the boundaries — and therefore the cache-hit numbers — carry over. The
`splitter_version` to stamp into G6's `chunk_config_hash` is
`@langchain/textsplitters@1.0.1`. (Note: `". "` never fires on this synthetic
corpus — paragraphs are space-joined tokens with no periods — so it does not move
the numbers versus langchain's default separators; it is kept for fidelity to the
G6 spec.)
