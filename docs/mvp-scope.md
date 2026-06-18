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

## Must Not Ship

- PDF.
- Graph.
- Full editor/write modes.
- Agent.
- Studio.
- Cloud/BYOK.
- Windows/Linux packaging.
- TTS/audio.
- Full onboarding polish.

## Agent Guidance

Agents must prefer this MVP scope over `docs/v1-scope.md` for first desktop
GUI alpha work. Do not use the full 12-24 month product vision to justify
adding PDF support, graph work, editor/write modes, Agent, Studio, cloud/BYOK,
TTS/audio, or non-macOS packaging to the alpha.
