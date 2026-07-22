---
name: offline-npm-install
description: In this sandbox the npm registry is unreachable; install deps with --offline from the local cache, never rm -rf node_modules blindly.
metadata:
  type: project
---

In the agent worktree sandbox, `registry.npmjs.org` is unreachable — every fetch fails with ETIMEDOUT, and plain `npm install` then crashes with the misleading `npm error Exit handler never called!` while leaving an INCOMPLETE `node_modules` (e.g. typescript/electron/vite/better-sqlite3 missing, so `tsc` is absent and gates can't run).

**Why:** No outbound network to the npm registry; the ~2.9G local cache at `~/.npm/_cacache` does hold the repo's pinned versions (typescript 6.0.3, electron 42.4.0, etc.).

**How to apply:** If deps are missing, run `npm install --offline --no-audit --no-fund` from the repo root — it resolves entirely from cache. It may take two passes ("changed N packages" then "changed 1 package") to settle the full tree. Do NOT `rm -rf node_modules` hoping a fresh `npm install` will refetch — it can't reach the registry and you'll be worse off. This repo installs typescript/electron/vite per-workspace (`packages/engine/node_modules/.bin/tsc`, `apps/desktop/node_modules/...`), not hoisted to root, so check workspace `.bin` dirs, not just root. See [[packaging-native-verification]] for the lockfile layout.
