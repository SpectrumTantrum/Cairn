# AGENTS.md / CLAUDE.md

This file provides guidance to Codex (Codex.ai/code) and Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

A **real, in-progress codebase plus its planning/feasibility artifacts** — one local-first, privacy-first product: **Cairn**, an agentic knowledge-management tool (NotebookLM + Cursor + Obsidian fusion; see `CONTEXT.md`). The desktop alpha has landed; there is app source code — do look for it.

- **`packages/engine`** (`@cairn/engine`) — the headless, in-process TypeScript indexing & retrieval engine (aka **Mneme**, now an internal module of Cairn, not a separate product). Grounded, cited **hybrid search** (dense **sqlite-vec** brute-force KNN + **FTS5** keyword, fused with **RRF**) over a Markdown vault, plus a `cairn` CLI (`index` / `search` / `ask`). Embeddings via a local **Ollama** `ModelProvider` seam. `src/` is real; `Index` (persistence) and `ModelProvider` (transport) are the seams.
- **`apps/desktop`** (`@cairn/desktop`) — the **Electron + React + TypeScript** desktop alpha wrapping the engine: index / search / ask panels + a source viewer. `VaultSession` (main process) owns vault path policy, the indexed guard, and engine orchestration.
- **Planning/feasibility artifacts** — `PRD-cairn.md`, `PRD-Mneme-Local-Document-Indexing.md`, the two `*-feasibility-report.md`, `docs/` (scope, ADRs, specs), `CONTEXT.md`, and `spikes/`.

Note: the standalone **Python Mneme** product described in `PRD-Mneme-Local-Document-Indexing.md` was **superseded** — per `CONTEXT.md` it is now Cairn's internal engine/indexing layer (implemented in-process in `@cairn/engine`; a Python ingestion *sidecar* is planned for multi-format parsing, see ADR-0009). The Mneme feasibility corrections below still bind that layer.

Git repo: **github.com/SpectrumTantrum/Cairn** (public, `main`).

### Doc authority (read before implementing)

`docs/v1-scope.md` + `docs/adr/` (ADRs **0001–0010**, including 0009 multi-format ingestion and 0010 the three-pane UI shell) **supersede the PRDs** for scope and technical decisions. `CONTEXT.md` + `docs/adr/` are the decision log / glossary. Precedence: **`docs/mvp-scope.md` overrides `docs/v1-scope.md` for the desktop alpha**; where any doc disagrees with the PRDs on *scope*, the scope doc wins; on *technical claims*, the feasibility reports + ADRs win.

### Build / run / test (verified)

Node ≥ 20, npm workspaces from repo root.

```bash
# Engine (@cairn/engine) — build + gate suite (compiles, then runs all node --test .mjs gates)
cd packages/engine && npm run test:smoke   # build + retrieval-gate/index-search/model-provider/retrieve/ask-coverage/reindex-pipeline
npm run build --workspace @cairn/engine     # tsc → dist/ (also `npm run engine:build` from root)
node packages/engine/dist/cli.js ask "…" --in ./notes   # CLI after build (index | search | ask)

# Desktop (@cairn/desktop) — build engine, typecheck test config, run VaultSession tests
cd apps/desktop && npm test                 # prepare:engine + tsc -p tsconfig.test.json + node --test test/vault-session.test.mjs
npm run desktop:dev                          # from root: electron-vite dev (builds engine first)

# From root: typecheck / build across all workspaces
npm run typecheck && npm run build
```

The engine gate suite is fully self-contained (fake `ModelProvider` + `InMemoryIndex`) — **no Ollama needed** to run it. Ollama is only required to actually embed against a real model at runtime.

## The reports override the PRDs (read this before implementing anything)

Each PRD was put through a skeptical feasibility review with spikes. **`cairn-feasibility-report.md`** and **`mneme-feasibility-report.md`** are authoritative: they contain corrections that contradict specific claims in the PRDs. If you implement from the raw PRD you will rebuild disproven assumptions. Read the report's *Verdict*, *Assumptions table*, *Spike findings*, and *Revised recommendation* first. (The Mneme corrections still bind Cairn's internal engine/indexing layer even though the standalone Python product was folded in.)

Binding corrections that are easy to get wrong:

**Cairn** (verdict: GO-WITH-CHANGES)
- `sqlite-vec` is a **brute-force linear KNN scan, not an ANN index** — fine at v1 scale (~18 ms / 50k chunks), O(n) beyond. The PRD's "ANN search" wording is inaccurate.
- Use Electron's built-in **`safeStorage`**, not `keytar` (archived 2022).
- pdf.js coordinate mapping for annotations is sound (spike-proven); the residual risk is UI plumbing. Defer **area annotations** before text highlights.
- The 16-week solo timeline is ~3–6× optimistic → descope v1; hardware-gate the local-model pull (default weak machines to a 3–4B model; prefer **Qwen3 (Apache-2.0)** over Llama weights).

**Mneme** (verdict: GO-WITH-CHANGES; corrections are simplifications)
- Chunk from Docling's **typed-block `DoclingDocument` model, not a normalized Markdown string** — markdown export is lossy and drops citation provenance.
- **Drop the `sparse` column and "bge-m3 → hybrid for free via Ollama."** Spikes proved Ollama `/api/embed` returns dense only, and LanceDB's keyword half is its own BM25 FTS over `text` (no sparse-vector support). Store `text`, FTS-index it, fuse with RRF.
- Simplify the Merkle **tree** to a flat `{path:(hash,mtime,size)}` snapshot + Git-index-style mtime gating.

## Permissive-license-only policy (hard constraint, load-bearing)

Cairn (engine + desktop) allows **only MIT / Apache-2.0 / BSD / MPL** dependencies. **AGPL/GPL is a blocker.** This is not theoretical — these specific traps recur and each has a vetted permissive escape:

| Capability | AGPL/GPL trap | Permissive replacement |
|---|---|---|
| PDF text/annotation editing | MuPDF / `mupdf.js`, **PyMuPDF (`fitz`)** | pdf.js (Apache) / **EmbedPDF** (MIT) / **pypdfium2** (BSD) |
| Document parsing (Mneme) | PyMuPDF; `ebooklib`; `unstructured` *extras* (ultralytics AGPL, chardet LGPL) | **Docling** (MIT, uses pypdfium2 + docling-parse) — handles PDF/DOCX/HTML/EPUB and needs none of them |
| Local TTS (Cairn Tier-2) | Piper-GPL fork / `espeak-ng` (GPL, bundled by `kokoro-js`) | **piper-plus** (MIT, espeak-free) |

When adding any dependency, confirm its license before use; flag AGPL/GPL and propose the permissive substitute.

## Spikes

`spikes/` holds throwaway proofs-of-concept (separate from the shipped engine/desktop code) that validated (or broke) the riskiest assumptions. Their conclusions are folded into the reports and the `*-findings.md` / `SPIKE-FINDINGS.md` notes; the code is kept for reproducibility. To re-run:

```bash
# sqlite-vec brute-force-vs-ANN + scaling (Node)
cd spikes/sqlite-vec && npm install && node perf.js

# pdf.js annotation coordinate mapping across zoom/rotation (Node, ESM)
cd spikes/pdfjs && npm install && node coords.mjs

# Mneme: chunk-hash cache hit-rate under edits (Python; v2 is authoritative)
python3 spikes/mneme/chunk_cache.py
uv run --with langchain-text-splitters python spikes/mneme/chunk_cache_v2.py

# Mneme: LanceDB embedded hybrid (dense + BM25-FTS + RRF) — needs Ollama + bge-m3
uv run --with lancedb python spikes/mneme/lancedb_hybrid.py

# Ollama embed + local tool-calling capability (Node) — needs Ollama + models
cd spikes/ollama && node capability.mjs
```

Ollama-dependent spikes need a local server (`ollama serve` on `localhost:11434`) and the relevant models pulled (`bge-m3`, `nomic-embed-text`, `llama3.2:3b`). Latency numbers from spikes were taken on a 128 GB / 18-core machine and are **not** representative of the PRDs' "8–16 GB student hardware" target — treat them as best-case ceilings.

## Conventions

- **Python: use `uv`, never `pip`.** One-off scripts: `uv run --with <pkg> python …` (ephemeral). This is why the Python spikes have no `requirements.txt` / venv.
- Node spikes are self-contained (`package.json` per spike dir); run `npm install` in the dir first.
- Local-first is a product invariant: no telemetry, no network calls except user-configured model endpoints (Ollama on localhost, or BYOK cloud APIs). "Zero outbound" holds at steady state but not at first-run model downloads — keep that distinction when reasoning about the privacy claims.
- Scope precedence lives under **Doc authority** above: `docs/mvp-scope.md` overrides `docs/v1-scope.md` for the desktop alpha — do not implement full v1 scope unless a later issue explicitly reopens it.
- `.remember/` holds session-continuity notes (not product content).

## Agent skills

### Issue tracker

Issues and PRDs are tracked as **GitHub issues** (`SpectrumTantrum/Cairn`) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root (created lazily by `/grill-with-docs`). See `docs/agents/domain.md`.
