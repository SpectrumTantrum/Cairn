# Memory index

- [Scoped retrieval design](project_scoped-retrieval-design.md) — scope enforced in SQL inside Index arms (json_each pre-filter), over-fetch dropped (issue #17); parallel-agent file ownership.
- [Packaging native verification](project_packaging-native-verification.md) — monorepo has 3 lockfiles (root+engine+desktop, only root npm ci needed); ELECTRON_RUN_AS_NODE trick verifies asar.unpacked native loading without touching main-process source.
