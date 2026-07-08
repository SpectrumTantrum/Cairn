---
name: phase3-deferrals
description: GitHub issues #27-#33 tracking everything deferred from the Phase-3 write-safety core slice
metadata:
  type: project
---

Phase 3's first slice shipped only the ADR-0008 write-safety core (Agent mode). Everything else was filed as issues rather than half-built:

- **#27** — Reconcile ADR-0008 §0 git binding (system git vs isomorphic-git). See [[git-binding-divergence]].
- **#28** — Synthesize / Recall / Plan write modes. Recall & Plan specs are UNCONFIRMED — do not invent their UX; confirm with Torres.
- **#29** — In-editor inline diff hunks (chat-side cards shipped instead).
- **#30** — Mid-loop blocking approval gate + step-cap partial-run UX (Continue+25/Revert/Keep&stop).
- **#31** — Revert-time keep-mine/take-revert prompt for files externally edited after a run.
- **#32** — Tool-calling capability probe + GBNF-constrained decoding + real 5-step-run reliability spike.
- **#33** — Anki TSV export (Phase-3 scope, its own slice).

**How to apply:** before starting any of these, check the issue for the latest state and confirm open UX decisions (esp. Recall/Plan, #28) with Torres. Verify referenced files/functions still exist — this list is a point-in-time snapshot.
