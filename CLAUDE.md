# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

A **spec-first feasibility workspace**, not an application codebase. There is **no app source code yet** — do not look for `src/`, a build, or an app to run. It contains the planning and validation artifacts for two unbuilt, local-first products:

- **Cairn** (`PRD-cairn.md`) — a local-first AI study companion: Obsidian-style markdown vault + agentic editing + grounded NotebookLM-style "Studio" outputs + first-class PDF annotation. Target stack: **Electron + React + TypeScript**.
- **Mneme** (`PRD-Mneme-Local-Document-Indexing.md`) — a fully-local, **Python**, retrieval-only document indexer that ports Cursor's incremental-indexing machinery (Merkle change detection + chunk-content-hash embedding cache) to heterogeneous documents (PDF/DOCX/HTML/MD/…).

The two relate: **Mneme is effectively the local RAG/indexing layer that Cairn's §6 pipeline needs.** They share the same north star — local-first, no cloud/telemetry, Ollama (local) + BYOK as swappable model providers, citations that jump to the exact source, and a **permissive-license-only** policy. The PRDs do not formally couple them; treat shared findings (embeddings, hybrid retrieval, LanceDB/sqlite-vec, citation anchoring) as transferable.

Git repo: **github.com/SpectrumTantrum/Cairn** (public, `main`). The PRDs and feasibility reports are the source of truth — there is no app code to consult yet.

## The reports override the PRDs (read this before implementing anything)

Each PRD was put through a skeptical feasibility review with spikes. **`cairn-feasibility-report.md`** and **`mneme-feasibility-report.md`** are authoritative: they contain corrections that contradict specific claims in the PRDs. If you implement from the raw PRD you will rebuild disproven assumptions. Read the report's *Verdict*, *Assumptions table*, *Spike findings*, and *Revised recommendation* first.

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

Both products allow **only MIT / Apache-2.0 / BSD / MPL** dependencies. **AGPL/GPL is a blocker.** This is not theoretical — these specific traps recur and each has a vetted permissive escape:

| Capability | AGPL/GPL trap | Permissive replacement |
|---|---|---|
| PDF text/annotation editing | MuPDF / `mupdf.js`, **PyMuPDF (`fitz`)** | pdf.js (Apache) / **EmbedPDF** (MIT) / **pypdfium2** (BSD) |
| Document parsing (Mneme) | PyMuPDF; `ebooklib`; `unstructured` *extras* (ultralytics AGPL, chardet LGPL) | **Docling** (MIT, uses pypdfium2 + docling-parse) — handles PDF/DOCX/HTML/EPUB and needs none of them |
| Local TTS (Cairn Tier-2) | Piper-GPL fork / `espeak-ng` (GPL, bundled by `kokoro-js`) | **piper-plus** (MIT, espeak-free) |

When adding any dependency, confirm its license before use; flag AGPL/GPL and propose the permissive substitute.

## Spikes — the only runnable code here

`spikes/` holds throwaway proofs-of-concept that validated (or broke) the riskiest assumptions. Their conclusions are folded into the reports and the `*-findings.md` / `SPIKE-FINDINGS.md` notes; the code is kept for reproducibility. To re-run:

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
- `.remember/` holds session-continuity notes (not product content).

## Agent skills

### Issue tracker

Issues and PRDs are tracked as **GitHub issues** (`SpectrumTantrum/Cairn`) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root (created lazily by `/grill-with-docs`). See `docs/agents/domain.md`.
