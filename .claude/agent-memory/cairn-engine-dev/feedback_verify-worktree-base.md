---
name: verify-worktree-base
description: In parallel git-worktree tasks, verify the worktree HEAD rather than trusting "base includes merged work X" claims
metadata:
  type: feedback
---

When dispatched into an isolated git worktree, do NOT trust a task's "base is current
main (includes just-merged #X, #Y)" claim — verify against the actual worktree HEAD.

**Why:** On issue #21 (vault mutations), the task said the base included the just-merged
#22 (sort modes) and #25 (thread persistence). It did NOT — the worktree HEAD (b620f51)
predated both; those changes existed only in the MAIN repo's uncommitted working copy.
The main repo and the worktree are separate checkouts and can diverge. I initially read
files via the main-repo absolute path and nearly built against the wrong versions (e.g.
`listTree(sort)` + `asSortMode` that don't exist in the worktree base).

**How to apply:** (1) Always read/edit files via the worktree absolute path
(`.../.claude/worktrees/<id>/...`), never the main repo path. (2) Establish the real test
baseline by running the suite, not by trusting a quoted count (task said 51 passing; the
worktree base was actually 38). (3) Where a task assumes a not-yet-present dependency
(e.g. "preserve the current sort mode"), degrade gracefully to what the base supports and
flag the gap in the report rather than inventing the missing API. See [[project_scoped-retrieval-design]]
for the parallel-agent file-ownership context this arose from.
