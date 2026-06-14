# Chunk at 512 tokens / 15% overlap, structure-aware, fingerprinted by chunk_config_hash

Cairn chunks to a **512-token target with 15% overlap**, splitting structure-first (Markdown by heading hierarchy then a size-cap; PDF per-page then sub-chunk oversized pages) with a separator-respecting recursive splitter, and stamps a **`chunk_config_hash`** into the index `meta` so any later parameter change is an explicit, surfaced re-index — never a silent partial corruption of the embedding cache. This overrides the PRD's 800-token / 100-token-overlap. Full spec: [`docs/engineering-decisions.md` §G6](../engineering-decisions.md).

## Considered options

- **PRD's 800 tokens / 100 overlap:** larger context per chunk, but unmeasured — no cache-hit or retrieval evidence behind it for this stack.
- **512 / 15% (chosen):** the exact config the Spike-A cache-hit numbers (94–96% on structured prose) were measured against, so that evidence transfers. Also finer retrieval precision and tighter citation spans.

## Consequences

- **Hard to reverse:** changing *any* chunking parameter changes `chunk_config_hash`, which invalidates every cached embedding and forces a full re-extract/re-chunk/re-embed. That is exactly why it is fingerprinted and surfaced rather than silent.
- Pin **one** token-length function (char-approximation at ~3.5 chars/token) across all paths — mixing a real tokenizer in some paths changes boundaries, hence hashes.
- Spike-A's real finding stands: hit-rate is dominated by extraction determinism and separator structure, not chunk size — so 512 is chosen for *measured-config transfer* + precision, not for caching better than 800.
