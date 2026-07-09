# Cairn — docs index

The decision log and specs for Cairn. This file is a map, not a source of truth — each doc below is authoritative for its own area.

## Precedence (read this before implementing)

When two docs disagree, resolve in this order:

1. **`mvp-scope.md` overrides `v1-scope.md`** for the desktop alpha. Don't build full v1 scope unless a later issue reopens it.
2. **On *scope*:** the scope docs (`v1-scope.md`, `mvp-scope.md`) beat the root PRDs (`PRD-cairn.md`, `PRD-engine-local-document-indexing.md`).
3. **On *technical claims*:** the `adr/` decisions + the root feasibility reports (`cairn-feasibility-report.md`, `engine-feasibility-report.md`) beat the PRDs.
4. **Glossary / decision log:** `../CONTEXT.md` + `adr/`.

## Scope

| Doc | What it governs |
|---|---|
| [`v1-scope.md`](v1-scope.md) | Authoritative v1.0 scope lock (the full product; ~12–24mo). |
| [`mvp-scope.md`](mvp-scope.md) | Desktop alpha scope — **overrides `v1-scope.md`** for the first GUI release. |

## Engineering decisions

| Doc | What it covers |
|---|---|
| [`engineering-decisions.md`](engineering-decisions.md) | Concrete build-time defaults for gaps G5–G14 (the *how* to `v1-scope.md`'s *what*). |
| [`model-strategy.md`](model-strategy.md) | Tiered always-on local models + BYOK cloud escalation; hardware tiers. Snapshot June 2026 — treat model names/sizes as point-in-time. |
| [`spike-verdicts-correction.md`](spike-verdicts-correction.md) | Honest standing of the v1 build-prerequisite spikes. `rag-quality` RESOLVED; the other three remain provisional — don't cite their PASS verdicts as ADR-grade. |

## Architecture decision records — [`adr/`](adr/)

| ADR | Decision |
|---|---|
| [0001](adr/0001-typescript-in-process-engine.md) | Engine in TypeScript, in-process in Electron's main (not Python/Docling). |
| [0002](adr/0002-tiered-always-on-models-with-cloud-escalation.md) | Tiered always-on local models with explicit BYOK cloud escalation. |
| [0003](adr/0003-heterogeneous-node-graph-over-plain-files.md) | Heterogeneous node graph over plain files (not a native graph DB). |
| [0004](adr/0004-tiered-pdf-text-extraction.md) | Tiered PDF text extraction: pdf.js text layer → Tesseract OCR → vision-model escalation. |
| [0005](adr/0005-knowledge-management-not-nd-study-companion.md) | Cairn is a knowledge-management tool, not a neurodivergent study companion. |
| [0006](adr/0006-chunking-512-15-structure-aware.md) | Chunk at 512 tokens / 15% overlap, structure-aware, fingerprinted by `chunk_config_hash`. |
| [0007](adr/0007-external-fuzzy-citation-anchors.md) | External fuzzy citation anchors (no IDs in user Markdown); page-level PDF anchors; annotations keyed by content hash. |
| [0008](adr/0008-agent-write-safety-and-run-revert.md) | Agent write-safety: pre-run checkpoint, per-file approval gate, one-commit-per-run, byte-identical revert. |
| [0009](adr/0009-multi-format-ingestion-index-cite-everything-edit-markdown.md) | Multi-format ingestion: index & cite everything, edit only Markdown; Docling + whisper.cpp via a Python sidecar. |
| [0010](adr/0010-desktop-ui-shell-three-pane-obsidian-left-cursor-right.md) | Desktop UI shell: three panes — Obsidian vault rail (left), CodeMirror 6 editor (center), Cursor-style agent sidebar (right). |

## Specs — [`specs/`](specs/)

| Spec | Covers |
|---|---|
| [`G10-retrieval-api.md`](specs/G10-retrieval-api.md) | `search_notes` retrieval API — filter schema, RRF fusion, "not covered" gate, ungrounded toggle. |

## Agent skills — [`agents/`](agents/)

How agents should consume this repo's conventions.

| Doc | Covers |
|---|---|
| [`domain.md`](agents/domain.md) | How to consume `CONTEXT.md` + `adr/` when exploring the codebase. |
| [`issue-tracker.md`](agents/issue-tracker.md) | Issues & PRDs as GitHub issues via the `gh` CLI. |
| [`triage-labels.md`](agents/triage-labels.md) | Default triage-label vocabulary. |
