---
name: git-binding-divergence
description: Write-safety core uses system git in a dedicated repo, not isomorphic-git as ADR-0008 §0 mandates; open reconciliation in issue #27
metadata:
  type: project
---

The agent write-safety core (`apps/desktop/src/main/agent-checkpoint.ts`) implements the checkpoint/apply/revert with **system git via `execFile`**, NOT isomorphic-git.

**Why:** ADR-0008 §0 says "isomorphic-git only; never mix with system git" (autocrlf byte-identity concern). But the Phase-3 dispatch directed system git with **zero new dependencies** (isomorphic-git would be a new npm dep; Cairn's hard license/dep policy prefers zero). This is a real doc/code contradiction, filed as issue #27 (recommend amending the ADR).

**How the ADR's guarantees are preserved:**
- Dedicated checkpoint repo at `<vault>/.cairn/checkpoints.git` with the vault as work-tree — the user's own `.git` is never touched, so there is no "mixing" and no "hard-reset nukes unrelated history" hazard.
- `core.autocrlf=false` on that repo neutralises the exact concern the ADR cited.
- The provable acceptance test is kept verbatim: revert asserts `tree(C) === tree(A)` via `git rev-parse <c>^{tree}`.

**How to apply:** if you touch the write-safety core, do NOT "fix" it to isomorphic-git without checking issue #27's resolution first — the system-git-in-a-dedicated-repo choice is deliberate and mitigated. The dedicated-repo pattern also handles non-git vaults uniformly (no need to init the user's vault as a repo).
