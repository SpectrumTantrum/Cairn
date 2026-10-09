# Cairn

**A local-first, privacy-first desktop app for a Markdown vault.** Notes stay in the folder you choose. There is no telemetry. Local models run through [Ollama](https://ollama.com). Bring-your-own-key cloud models are optional.

This repo has the desktop app and the headless engine `@cairn/engine` ([ADR-0001](docs/adr/0001-typescript-in-process-engine.md)). You index a folder of Markdown, search it, and ask questions answered from those notes.

**Classic Ask is the default.** Agentic search (agentic Ask) is opt-in. The setting `cairn.agenticAsk` is off until you turn it on, and the launch flag `CAIRN_AGENTIC_ASK` is off unless you set it to `1`. Agentic Ask has been tested on the Ollama model `qwen3:8b` only.

With agentic Ask on, the desktop app shows each search and tool step live. Clicking a citation opens the cited note, at the matched heading when Ask located the passage. Otherwise the chip says 'file' and opens the top of the note.

An agentic Ask answer takes a few minutes on `qwen3:8b` (about 2 to 3 minutes measured on small test vaults).

## Enable agentic Ask

Agentic Ask is a desktop setting. The engine CLI `ask` command is classic Ask.

1. Open **Settings** (the gear on the vault rail).
2. Under **Ask / Chat**, turn on **Agentic Ask (experimental)**.

That checkbox writes the setting `cairn.agenticAsk` (`1` when on, `0` when off). When the key is unset and `CAIRN_AGENTIC_ASK` is not `1`, agentic Ask is off.

To enable it for a launch before that setting is saved, start the desktop app with the environment flag set to exactly `1`:

```bash
CAIRN_AGENTIC_ASK=1 npm run desktop:dev
```

The desktop main process reads `CAIRN_AGENTIC_ASK`. A saved `cairn.agenticAsk` value is what the app uses after you change the checkbox.

## Install and run

**Node ≥ 20**, from the `engines` field in the root [`package.json`](package.json) and in [`packages/engine/package.json`](packages/engine/package.json).

From the repository root:

```bash
npm install

# Build every workspace (@cairn/engine `tsc`; @cairn/desktop typecheck + electron-vite build)
npm run build

# Desktop development. `predev` builds the engine, then starts Electron.
npm run desktop:dev

# Desktop typecheck, production build, and a preview of that build
npm run desktop:typecheck
npm run desktop:build
npm run desktop:preview

# Engine build only
npm run engine:build
```

Root scripts: `build`, `desktop:dev`, `desktop:typecheck`, `desktop:build`, `desktop:preview`, `engine:build`, `check:lockfile`, `typecheck`.

Engine CLI, after `npm run build` or `npm run engine:build` (the `@cairn/engine` `build` script emits `packages/engine/dist/cli.js`):

```bash
# Keyword-only index. No Ollama.
node packages/engine/dist/cli.js index /path/to/notes --lexical
node packages/engine/dist/cli.js search "spaced repetition" --in /path/to/notes

# Default index. Needs a local Ollama server and an embedding model.
node packages/engine/dist/cli.js index /path/to/notes
node packages/engine/dist/cli.js search "why did we choose X" --in /path/to/notes

# Classic Ask. Needs Ollama and a local chat model.
node packages/engine/dist/cli.js ask "why did we choose X over Y?" --in /path/to/notes
```

`search` prints each hit as `file:line › heading`. Classic `ask` answers from the indexed notes. When the notes do not cover the question, the answer is `Your notes don't cover this.` Index files live under `<folder>/.cairn/`. They are disposable and per-machine. The Markdown files are the source of truth. CLI details: [`packages/engine/engine-package.md`](packages/engine/engine-package.md).

## What's in this repo

| Path | What |
|---|---|
| [`apps/desktop/`](apps/desktop/) | Electron desktop app. Classic Ask is the default. Agentic Ask uses `cairn.agenticAsk` / `CAIRN_AGENTIC_ASK`. |
| [`packages/engine/`](packages/engine/) | Headless engine and CLI (`index`, `search`, classic `ask`) |
| [`PRD-cairn.md`](PRD-cairn.md), [`PRD-engine-local-document-indexing.md`](PRD-engine-local-document-indexing.md) | Product requirements for Cairn and its engine |
| [`cairn-feasibility-report.md`](cairn-feasibility-report.md), [`engine-feasibility-report.md`](engine-feasibility-report.md) | Spike-backed feasibility reviews. These override the PRDs where they disagree. |
| [`docs/adr/`](docs/adr/) | Architecture Decision Records (0001–0010) |
| [`docs/mvp-scope.md`](docs/mvp-scope.md) · [`docs/v1-scope.md`](docs/v1-scope.md) · [`docs/engineering-decisions.md`](docs/engineering-decisions.md) · [`docs/model-strategy.md`](docs/model-strategy.md) | Desktop alpha scope, v1 scope, build specs, model tiers |
| [`CONTEXT.md`](CONTEXT.md) | Project glossary (the canonical terms) |
| [`spikes/`](spikes/) | Throwaway proofs-of-concept for the riskiest assumptions |

> The spikes' "PASS" numbers are being re-examined. An adversarial review found the retrieval evals lexically leaky. Read [`docs/spike-verdicts-correction.md`](docs/spike-verdicts-correction.md) before citing them.

## Principles

- **Local-first.** No telemetry. Network calls go only to model endpoints you configure: Ollama on localhost, or a cloud endpoint you add.
- **Cited.** Search results name the note as `file:line › heading`. With agentic Ask on, clicking a citation opens the cited note, at the matched heading when Ask located the passage. Otherwise the chip says 'file' and opens the top of the note.
- **Permissive-license-only.** MIT / Apache-2.0 / BSD / MPL dependencies only. AGPL/GPL dependencies are excluded.

## License

[MIT](LICENSE).
