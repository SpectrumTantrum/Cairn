# Cairn

**A local-first, privacy-first agentic knowledge-management tool** — NotebookLM's grounded
Q&A + generated outputs, Cursor's agentic editing with modes, and Obsidian's Markdown vault +
graph, fused into one app. Everything runs on your machine: no telemetry, no cloud required —
local models via [Ollama](https://ollama.com), with bring-your-own-key cloud models optional.

It's built on an internal local indexing & retrieval engine (`@cairn/engine`) that watches your
vault, chunks and embeds your documents, and serves **cited** hybrid search — answers that jump
to the exact source.

> **Status — early.** The full desktop product (PDF annotation, generated "Studio" outputs, six
> agent modes, the heterogeneous graph) is a 12–24-month build and **not here yet**. What *is*
> here today: this repo's planning corpus (PRDs, a skeptical spike-backed feasibility review,
> architecture decisions) **and a runnable MVP** — a headless CLI tracer of the engine that
> indexes a Markdown folder and runs grounded, cited search over it.

## Try the MVP (CLI)

A headless engine ([ADR-0001](docs/adr/0001-typescript-in-process-engine.md)) you can point at
any folder of Markdown notes. Needs **Node ≥ 23.6** (runs TypeScript directly — no build step).

```bash
cd packages/engine
npm install

# Keyword-only — no model, runs anywhere
node src/cli.ts index /path/to/notes --lexical
node src/cli.ts search "spaced repetition" --in /path/to/notes

# Hybrid (dense + keyword + RRF) — needs Ollama + an embedder
ollama pull qwen3-embedding:0.6b
node src/cli.ts index /path/to/notes
node src/cli.ts search "why did we choose X" --in /path/to/notes

# Ask a grounded, cited question (also needs a chat model: ollama pull qwen3:4b)
node src/cli.ts ask "why did we choose X over Y?" --in /path/to/notes
```

`search` results come back as `file:line › heading` citations; `ask` answers **only** from
your notes — every claim cites a source, and it refuses rather than guess when nothing matches. The index lives in `<folder>/.cairn/` —
disposable and per-machine; your Markdown files are the source of truth. See
[`packages/engine/README.md`](packages/engine/README.md) for details.

## What's in this repo

| Path | What |
|---|---|
| [`packages/engine/`](packages/engine/) | The MVP — headless engine CLI (index + cited hybrid search) |
| [`PRD-cairn.md`](PRD-cairn.md), [`PRD-Mneme-Local-Document-Indexing.md`](PRD-Mneme-Local-Document-Indexing.md) | Product requirements for Cairn and its engine |
| [`cairn-feasibility-report.md`](cairn-feasibility-report.md), [`mneme-feasibility-report.md`](mneme-feasibility-report.md) | Skeptical, spike-backed feasibility reviews — these **override** the PRDs where they disagree |
| [`docs/adr/`](docs/adr/) | Architecture Decision Records (0001–0008) |
| [`docs/v1-scope.md`](docs/v1-scope.md) · [`engineering-decisions.md`](docs/engineering-decisions.md) · [`model-strategy.md`](docs/model-strategy.md) | Scope lock, build specs, model tiers |
| [`CONTEXT.md`](CONTEXT.md) | Project glossary (the canonical terms) |
| [`spikes/`](spikes/) | Throwaway proofs-of-concept for the riskiest assumptions |

> ⚠️ The spikes' "PASS" numbers are being re-examined — an adversarial review found the retrieval
> evals lexically leaky. Read [`docs/spike-verdicts-correction.md`](docs/spike-verdicts-correction.md)
> before citing them.

## Principles

- **Local-first / zero-telemetry.** No network calls except the model endpoints you configure
  (local Ollama, or your own cloud key). Your notes never leave your machine.
- **Grounded, always cited.** Retrieval points back to the exact spot in the source.
- **Permissive-license-only.** MIT / Apache-2.0 / BSD / MPL dependencies only — no AGPL/GPL.

## License

[MIT](LICENSE).
