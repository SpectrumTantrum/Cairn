# Agent write-safety: pre-run checkpoint, per-file approval gate, one-commit-per-run, hand-rolled byte-identical revert

All write-modes (Synthesize, Recall, Plan, Agent) run on one headless write-safety core. Before any write, a **git checkpoint commit (A)** captures the user's pre-run tree. Every write passes a **per-file diff-approval gate** — injected as an `async (proposal) => approve|reject|cancel` callback so the engine stays Electron/DOM-free (ADR-0001). All approved writes of a run land in **exactly one commit (B)**. The Agent loop **hard-stops at a manifest-configurable step cap (default 25)** with a visible message. **"Revert this run"** is a hand-rolled procedure (diff A↔B → `checkout --force` modified/deleted paths from A → `fs.unlink` agent-created paths → forward "revert" commit C → assert `tree(C) === tree(A)`). External (Obsidian) edits mid-run are caught by re-read+hash immediately before each write. Full spec + algorithm: [`docs/engineering-decisions.md` §G14](../engineering-decisions.md).

## Considered options

- **"git revert the run commit + git clean the new files":** the obvious approach — but **unimplementable on isomorphic-git**, which has neither a porcelain `revert` nor `git clean` (verified against its API; `checkout` restores the working dir, `remove` only un-stages). Rejected because it cannot be built.
- **Hand-rolled tree-diff → checkout-force → unlink → forward-commit, with a `tree(C)===tree(A)` assertion (chosen):** turns the PRD/report's "byte-identical revert" claim into a *provable* assertion rather than a hope.

## Consequences

- **Two commits per run, not one:** checkpoint A captures the *user's* dirty edits; run-commit B captures *only* the agent's approved writes (stage only approved paths — never `git add -A`). Revert operates strictly on the A→B delta, so it can never entangle the user's own pending work. The trade-off: the user's dirty tree is committed up front as the checkpoint.
- **The approval gate is the load-bearing safety invariant:** no write reaches disk without a resolution, so a flaky local-model loop produces *rejected steps, never a corrupted vault*. This is what makes unreliable local multi-step tool-loops safe to ship.
- **Concurrency:** before each write, mtime-gate then content-hash against what the write was derived from; on mismatch, abort that step and surface it — never clobber an external edit. A post-run external edit to a run-touched file is handled by a per-file keep-mine/take-revert prompt at revert time.
- **Local transport:** if Ollama's stream+tools bug (#15497) trips on the target version, fall back to non-streaming polling for tool-call turns only; prefer grammar-constrained decoding (node-llama-cpp GBNF) for schema-valid tool calls. (Open: the hand-rolled revert and the 25-step local-model loop are both unproven — gated by the `spikes/agent-loop` spike and a dedicated add+modify+delete→revert test.)
