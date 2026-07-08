# Memory index

- [ADR-0008 git binding divergence](project_git-binding-divergence.md) — write-safety core uses SYSTEM git in a dedicated repo, diverging from ADR-0008 §0's "isomorphic-git only"; tracked in issue #27.
- [Write-safety architecture split](project_write-safety-architecture.md) — engine = proposal-only tool loop (never writes); main process = git checkpoint/apply/revert; collect-then-approve, not mid-loop blocking gate.
- [propose_edit uses full newContent not patches](feedback_propose-edit-full-content.md) — full-file rewrites beat unified patches for small local models; we derive the diff ourselves.
- [Phase 3 deferrals filed as issues](project_phase3-deferrals.md) — issues #27-#33 cover the write-modes deferrals (Synthesize/Recall/Plan, in-editor hunks, Anki TSV, etc.).
