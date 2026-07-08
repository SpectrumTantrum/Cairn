---
name: packaging-native-verification
description: How to verify packaged Electron native modules (better-sqlite3 ABI, sqlite-vec asar.unpacked rewrite) without touching main-process source, and monorepo lockfile layout for CI.
metadata:
  type: project
---

Cairn has three committed `package-lock.json` files: repo root, `packages/engine`,
and `apps/desktop`. `npm ci` at the repo root (npm workspaces) is sufficient to
install everything for `packages/engine` and `apps/desktop` — you do not need to
`npm ci` separately in each subdirectory. `packages/engine/node_modules` and
`apps/desktop/node_modules` still hold some non-hoisted packages (native modules,
Electron-specific deps) alongside the hoisted root `node_modules`.

**Why:** discovered while building `.github/workflows/ci.yml` for issue #11
(MVP-10) — needed correct `cache-dependency-path` entries for
`actions/setup-node`. All three lockfiles should be listed for cache-key
purposes even though only root `npm ci` is run.

**How to apply:** any future CI/lockfile work should list all three
`package-lock.json` paths for `actions/setup-node`'s `cache-dependency-path`,
but only ever run `npm ci` once, at the repo root.

---

To verify the packaged Electron app's native module stack (better-sqlite3 ABI,
sqlite-vec's `vec0` extension loading from `app.asar.unpacked`) **without**
adding debug logging to `apps/desktop/src/main` (which may be out of scope for
a given task), run the packaged binary itself in Node-emulation mode:

```bash
ELECTRON_RUN_AS_NODE=1 "release/mac-arm64/Cairn.app/Contents/MacOS/Cairn" -e "<script>"
```

This is the *same* Electron binary/V8/ABI as the full GUI process, so a
`require()` of the packaged `better-sqlite3` addon there is a real ABI test —
not a system-Node stand-in. From inside that process you can `require()`
modules straight out of `app.asar` (Electron's fs shim understands the asar
format; plain system `node` cannot), call `sqlite-vec`'s
`getLoadablePath()` to see the raw (unpacked-unaware) resolved path, apply the
same `.asar` → `.asar.unpacked` regex `SqliteIndex.loadVecExtension` uses, and
then actually `db.loadExtension()` the rewritten path and run `vec_version()`
to prove the dylib really loads (not just that the file exists on disk).

**Why:** issue #11 (MVP-10) explicitly asked to prove the asar→asar.unpacked
rewrite "actually fires," and the task's constraints disallowed touching
main-process source. This technique proves it end-to-end using the real
packaged artifact instead.

**How to apply:** reuse this pattern for any future packaging/native-module
verification task (e.g. after upgrading Electron, better-sqlite3, or
sqlite-vec) instead of adding temporary console.log statements to main.ts.
Remember `postpackage` restores `better-sqlite3` to system Node ABI — always
re-run `packages/engine`'s `test:smoke` after a repackage to confirm the
restore worked.
