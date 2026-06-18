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

- macOS packaging is not configured yet.
- `shell.openPath` opens the cited file but cannot position the external editor
  at the exact line. The in-app source viewer still shows the cited chunk and
  line number.
- Ask requires a local Ollama chat model. The app does not download models.
- Current dependency audit reports dev-tooling advisories through
  Vite/electron-vite/esbuild. Review before release packaging.
