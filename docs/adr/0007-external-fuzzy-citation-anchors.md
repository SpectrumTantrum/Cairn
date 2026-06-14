# External fuzzy citation anchors (no IDs in user Markdown); page-level PDF anchors; annotations keyed by content hash

Cairn anchors citations **without injecting any stable IDs into the user's Markdown.** A Markdown citation is an *external* anchor — stable heading-slug + char-offset + a short context window — fuzzy-resolved at click time with vendored **diff-match-patch (Apache-2.0)**. A PDF citation is **page + char-range + quote snippet**, where the page is always stable (consistent with ADR-0004's page-level citations). PDF **annotations are user data**, stored in a vault sidecar keyed by **SHA-256(PDF content), not path**, so they survive rename/move and re-attach after a disposable-index rebuild. Full spec: [`docs/engineering-decisions.md` §G8](../engineering-decisions.md).

## Considered options

- **Inject stable anchor IDs into the Markdown** (e.g. block IDs): gives exact, drift-proof anchors, but pollutes the user's plain files and breaks the Obsidian-compatible / "delete the app, keep everything readable" invariant (ADR-0003). Rejected.
- **External anchors, fuzzy-resolved (chosen):** the user's Markdown stays untouched; anchors are resolved by locating the heading then fuzzy-matching the quote near the offset.

## Consequences

- **Real trade-off:** Markdown anchors have **no correctness guarantee** — a large edit can silently move a citation; resolution then degrades to section-level ("approximate location"). Accepted for v1; a **citation-health-check batch op is v1.1**.
- PDF anchoring is the robust case (page never drifts; the quote recovers offset drift if an extractor version bump shifts char offsets).
- `source_type='annotation'` chunks in the index exist precisely so content-hash-keyed annotations can re-bind to their PDF on rebuild. The sidecar must live in a **synced, non-disposable** location (not swept by the `.cairn/` git-ignore rule) or annotations get wiped on re-index.
- `diff-match-patch` is Apache-2.0 (clean to vendor); apache/annotator + Hypothesis are archived design references only.
