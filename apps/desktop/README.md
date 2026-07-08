# Cairn Desktop Alpha

Electron + React + TypeScript shell for the first Cairn desktop GUI alpha. It
wraps `@cairn/engine` in Electron's main process and exposes a narrow preload
API to the renderer.

## Scope

This app follows [`docs/mvp-scope.md`](../../docs/mvp-scope.md). It is only for
Markdown vault search and optional local Ask through Ollama.

It does not ship PDF support, graph view, editor/write modes, Agent, Studio,
cloud/BYOK, telemetry, or Windows/Linux packaging.

## Install

From the repo root:

```bash
npm install
```

The desktop app depends on the built engine package. The desktop scripts run
`packages/engine`'s build first so a fresh checkout does not rely on stale local
`dist/` output.

## Run

```bash
# Development mode
npm run desktop:dev

# Typecheck and production build
npm run desktop:typecheck
npm run desktop:build

# Preview the production build
npm run desktop:preview
```

Equivalent package-local commands also work from `apps/desktop/`.

## Package a macOS `.app`

Packaging uses [electron-builder](https://www.electron.build/) (MIT). It is
configured in [`electron-builder.yml`](./electron-builder.yml) and targets macOS
only (matching the MVP scope — no Windows/Linux packaging).

```bash
# From apps/desktop/ — fast unpacked .app for local dogfooding:
npm run package
#   -> release/mac-arm64/Cairn.app

# Distributable dmg + zip (still unsigned; see caveats below):
npm run package:dist
#   -> release/Cairn-<version>-arm64.dmg and .zip
```

`package` runs `--dir` (an unpacked bundle, fastest to iterate); `package:dist`
produces `dmg` + `zip` artifacts. Output goes to `apps/desktop/release/`
(gitignored).

### Native modules (the tricky part)

`@cairn/engine` depends on two native pieces that must match the runtime's ABI:

- **better-sqlite3** — a compiled Node addon. The packaged app runs on Electron's
  ABI, not system Node's, so it must be rebuilt for Electron before packaging.
- **sqlite-vec** — ships a prebuilt loadable extension (`vec0.dylib`). It is
  ABI-independent, but `db.loadExtension()` is a native SQLite call that bypasses
  Electron's asar filesystem shim, so the `.dylib` must be **unpacked** from
  `app.asar` and loaded from the real path. The engine rewrites the resolved path
  `…/app.asar/…` → `…/app.asar.unpacked/…` for exactly this reason.

Because `better-sqlite3` is hoisted into `packages/engine/node_modules` and is
**shared** between the engine's Node test gates / `cairn` CLI (system Node ABI)
and the packaged app (Electron ABI), a single install can only hold one ABI at a
time. The packaging scripts handle this deterministically:

- `prepackage` rebuilds `better-sqlite3` for the installed Electron's ABI
  (`scripts/rebuild-engine-native.mjs electron`), then electron-builder packs it
  (`npmRebuild: false` — electron-builder's built-in rebuild is disabled because
  its per-ABI `bin/` cache skipped non-deterministically in this layout).
- `postpackage` restores `better-sqlite3` to the **system Node ABI**
  (`scripts/rebuild-engine-native.mjs node`) so `packages/engine` tests and the
  CLI keep working afterward. The packaged `.app` already contains its own
  Electron-ABI copy, so restoring the source is safe.

If you ever run engine Node tests and get an `ERR_DLOPEN_FAILED` /
`NODE_MODULE_VERSION` mismatch, the shared install is in the Electron-ABI state —
run `npm run rebuild:engine-node`-equivalent restore: from `apps/desktop/`,
`node scripts/rebuild-engine-native.mjs node` (or just `npm --prefix
../../packages/engine rebuild better-sqlite3`).

### Unsigned / not notarized (known limitation)

This build is intentionally **unsigned and not notarized** (`mac.identity: null`).
Code signing and Apple notarization are out of scope for this alpha; a later
packaging issue can add them.

Because it is unsigned, macOS **Gatekeeper** will quarantine the `.app` when it is
downloaded or copied from another machine and refuse to open it ("Cairn is
damaged / cannot be opened / from an unidentified developer"). For local
dogfooding of a build you produced yourself this usually does not trigger. If it
does, either right-click the app and choose **Open** (then confirm once), or clear
the quarantine attribute:

```bash
xattr -dr com.apple.quarantine "release/mac-arm64/Cairn.app"
```

Do not distribute this artifact publicly — an unsigned build is for local/internal
use only until signing + notarization land.

## Current Flow

1. Choose a Markdown vault folder.
2. Index it. Use lexical mode when Ollama or an embedding model is unavailable.
3. Search cited chunks.
4. Select a result to inspect the read-only source chunk.
5. Use Ask only when local Ollama and a compatible chat model are available.

The disposable index is stored under `<vault>/.cairn/index.db`.

## Security Notes

- Renderer has `nodeIntegration: false`.
- Renderer access to Electron/Node is limited to the typed preload API.
- IPC handlers run in Electron main and pin operations to the dialog-selected
  vault.
- Source opening rejects files outside the selected vault.
- No telemetry or cloud calls are added by the app.

## Known Limitations

- The packaged `.app` is unsigned and not notarized; see the Gatekeeper caveat
  under "Package a macOS `.app`". macOS-only by design (MVP scope).
- `shell.openPath` opens the cited file but cannot position the external editor
  at the exact line. The in-app source viewer still shows the cited chunk and
  line number.
- Ask requires a local Ollama chat model. The app does not download models.
- Current dependency audit reports dev-tooling advisories through
  Vite/electron-vite/esbuild. Review before release packaging.
