# Engine in TypeScript, in-process in Electron's main (not Python/Docling)

Cairn is one product whose shell must be Electron + TypeScript, so we build the indexing/retrieval engine in TS/Node running in Electron's main process, rather than as the Python service its own PRD described. The feasibility work removed Python's main advantages here — embeddings run over Ollama's HTTP API (language-agnostic), `sqlite-vec` is adequate at student-vault scale, and the learned-sparse path that needed FlagEmbedding was already dropped (Spikes B/C) — leaving one language and one runtime, which is decisive for a solo build and Electron packaging.

## Considered options

- **Python engine as a sidecar** (keep Docling + LanceDB; Electron spawns it over local HTTP/stdio): best parsing/retrieval quality and matches the engine's original PRD [`PRD-Mneme-Local-Document-Indexing.md`, the engine's retired standalone-product name], but bundling a Python runtime + torch/Docling models (hundreds of MB–GBs) inside a notarized Electron app is a heavy, fragile packaging burden for a solo dev.
- **Hybrid** (TS core in-process + an on-demand Python Docling sidecar for PDF extraction only): keeps Docling where it matters but still ships Python.

## Consequences

- We lose Docling's layout-aware PDF extraction; PDFs are parsed with pdf.js `getTextContent` (already in the stack for the viewer). If chunk/citation quality on complex PDFs proves insufficient, revisit by adding a Docling sidecar (the hybrid option) — this is the one part of the decision that stays partially reversible. — **Amended by ADR-0009 (2026-07-07):** the hybrid escape hatch is now taken — a bundled Python ingestion sidecar (Docling + whisper.cpp) ships in v1 — but it is scoped to **parsing/transcription only**. The retrieval engine (index, embed orchestration, hybrid search) stays TypeScript in-process, so this ADR's core invariant holds unchanged; only the "no Python runtime anywhere in the app" corollary is relaxed.
- The engine must stay free of Electron/DOM dependencies so it remains headless and CLI-testable. — **Amended by ADR-0009 (2026-07-07):** still binding for the retrieval engine; the new Python sidecar sits *outside* this core (ingestion feeds the same chunk→embed→index path), so the headless, CLI-testable engine is not affected.
