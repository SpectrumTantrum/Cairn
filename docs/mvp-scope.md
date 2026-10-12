# Cairn Desktop Alpha - MVP Scope

This document overrides `docs/v1-scope.md` for the first GUI release only.
It governs only the first desktop GUI alpha; `docs/v1-scope.md` still governs
the full v1.0 product vision.

## Goal

Ship a macOS Electron GUI around `packages/engine` for Markdown vault search
and optional local Ask.

## Must Ship

In priority order:

1. Choose vault folder.
2. Index Markdown files.
3. Search with citations.
4. Optional Ask using local Ollama when available.
5. Click citation to source.
6. Local-only operation: no telemetry and no cloud calls.
7. Store the disposable index at `<vault>/.cairn/index.db`.

## Milestones

Desktop Alpha 0:

- GUI shell.
- Choose vault.
- Index Markdown files.
- Lexical search.
- Clickable citations.

Desktop Alpha 1:

- Ollama detection.
- Ask UI.
- Grounded answers.
- Refusal when the indexed vault does not support an answer.

## First UI Shape

Build the thinnest useful GUI around the engine. It can be plain.

```text
Top bar:
  [Choose Vault] /path/to/vault
  [Index] [Lexical only checkbox]

Left:
  Search input
  Search results with file:line citations
  Read-only Markdown source pane

Right:
  Ask box
  Answer
  Sources list

Bottom/status:
  Indexing...
  Ollama unavailable
  Last indexed N files / N chunks
```

The first desktop alpha is not a full editor. A read-only Markdown source pane
is enough for MVP, as long as search and Ask citations can jump to the cited
file and line.

The three-pane shell redesign (Obsidian-style vault rail + CodeMirror 6 editor +
Cursor-style agent sidebar) is **v1 direction, not the alpha** — see `docs/adr/0010`.

> **Status update (superseded):** Torres approved building the three-pane v1 shell
> directly ("use the wireframe to make the real Cairn"), so the panel-based alpha UI
> (Search / Ask / Index panels: `App.tsx` grid + `VaultPicker`/`IndexPanel`/`SearchPanel`/
> `AskPanel`/`SourceViewer`) has been **replaced** by the three-pane shell in
> `apps/desktop/src/renderer`. This section documents the original alpha shape for
> history; it no longer describes the shipping UI. The engine contract and local-only
> invariants still bind. Format support is the shipped list below. OCR, Office,
> transcription, and the remaining Must-Not-Ship items stay out.

## What this alpha ships

The milestones above are the original alpha shape. The desktop app also ships the
following. Wording matches the README Agentic Ask section.

- Markdown notes. Search citations open the matched heading. Otherwise the chip says `file` and opens the top of the note.
- Text-layer PDFs. A page match cites `file p.N` and opens there. Scanned PDFs with no text layer are not read.
- Plain UTF-8 `.txt`, visible text in `.html` / `.htm`, and plain UTF-8 `.csv` / `.tsv`. Invalid, empty, or unreadable files are not read.
- Images (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`) open in the app. Ask does not read text from images.
- Audio (`.mp3`, `.wav`, `.m4a`) opens and plays. Ask does not transcribe audio.
- Video (`.mp4`, `.webm`, `.mov`) opens and plays. Ask does not transcribe video.
- A named file Ask cannot read is an honest miss: `Your notes don't cover this.`

Classic Ask is the default. Agentic Ask is opt-in (`cairn.agenticAsk` / `CAIRN_AGENTIC_ASK=1`) and has been tested on `qwen3:8b` only. The engine CLI `ask` command is classic Ask.

## Must Not Ship

- OCR, including text from images and from scanned PDFs with no text layer.
- Office documents and the other ADR-0009 formats that are not in the shipped list: DOCX, PPTX, EPUB.
- Audio and video transcription, and TTS.
- Graph.
- Full editor/write modes.
- Agent.
- Studio — except the grounded-generation pipeline + Study Guide proving slice, reopened by maintainer decision 2026-07-15 (issue #26); all seven templates shipped as registry entries.
- Cloud/BYOK.
- Windows/Linux packaging.
- Full onboarding polish.

Dense-retrieval quality is not an alpha claim. Hybrid search ships; the keyword arm carries the weight until retrieval quality is validated on its own.

## Agent Guidance

Agents must prefer this MVP scope over `docs/v1-scope.md` for first desktop
GUI alpha work. Do not use the full 12-24 month product vision to justify
adding OCR, Office (DOCX, PPTX), EPUB, transcription, TTS, graph work,
editor/write modes, Agent, Studio, cloud/BYOK, or non-macOS packaging to the
alpha. Text-layer PDF, `.txt`, HTML, CSV/TSV, image open, audio play, and
video play are already in the shipped list above.
