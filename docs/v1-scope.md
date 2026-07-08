# Cairn v1 — Scope Lock

**Ratified:** 2026-06-14 (Torres).
**Identity:** a local-first **agentic knowledge-management tool** — NotebookLM (grounded Q&A + studio outputs) + Cursor (agentic editing with modes) + Obsidian (Markdown vault + graph). **Not** a neurodivergent study companion (ADR-0005). Target: anyone managing their own knowledge.
**Decision:** ship the *full* product as **one v1.0** — not the feasibility report's descoped slice, and not a sequenced v1.0→v1.2 rollout. Realistic solo timeline **accepted: ~12–24 months**.

This document is the authoritative v1 **scope**. For architecture/technical decisions see `docs/adr/`; for terminology see `CONTEXT.md`. Where this doc and the PRDs disagree on *scope*, this wins. Where the PRDs make *technical claims*, the feasibility reports + ADRs win.

## In v1.0

**Vault & editing**
- Obsidian-compatible plain-Markdown vault; CodeMirror editor; `[[wikilinks]]` + backlinks; tags
- **Three-pane desktop shell (ADR-0010):** left rail = Obsidian-style vault navigation (file tree + backlinks/outline); center = CodeMirror 6 Markdown editor (MIT), polymorphic by node type (PDF → viewer, AV → player); right rail = Cursor-style agent sidebar. Agent edits render as **inline per-hunk accept/reject diffs in the editor** (ADR-0008), not in chat; citation click-through opens the anchor target in the center pane (ADR-0009). *v1 direction — the desktop alpha stays panel-based per `docs/mvp-scope.md`.*
- Heterogeneous **graph** over typed nodes — `note`, `pdf`, `flashcard` — all plain files, edges = wikilinks (ADR-0003)
- git auto-snapshots (isomorphic-git)

**Retrieval (in-process TS engine, ADR-0001)**
- Index = sqlite-vec + FTS5 + metadata under `.cairn/` (disposable, per-machine, never synced)
- **Hybrid search ON by default** (dense + FTS5 keyword + RRF) — *pending validation spike*
- Citations: markdown → heading/line; PDF → page + region flash
- Default embedder Qwen3-Embedding-0.6B (1024-dim), app-wide, switchable → re-index

**Sources & multi-format ingestion (ADR-0009)**
- **Index & cite everything; edit only Markdown** (+ PDF annotations). Non-Markdown files are read-only sources — parsed, chunked, indexed, citable, never edit targets
- Document sources — **PDF, DOCX, PPTX, HTML, EPUB** — parsed to typed blocks via **Docling (MIT)**, chunked *from blocks* (not lossy Markdown export), through the existing chunk→embed→index path
- **Audio & video** transcribed locally via **whisper.cpp (MIT)**; the transcript is the indexable text; citations are **timestamps that seek a player** (**video is in v1** — supersedes the deferral below)
- Images / scanned PDFs → OCR tier (ADR-0004)
- Ingestion runs in a **bundled Python sidecar** (Docling + whisper) spawned by Electron main, parsing only; heavy models fetched on first run, not bundled
- **Ship-gate:** a format ships only when citation click-through jumps to the exact source (char offset / page + bbox / timestamp)

**PDF**
- pdf.js viewer; **text highlights** (5 colors) + margin notes + **area/rectangle annotations** (diagrams); sidecar JSON keyed by PDF content hash; `[[pdf:]]` links; extract-annotations-to-note; selection → Explain
- **Tiered text extraction** (ADR-0004): pdf.js text → Tesseract OCR (scanned) → vision-model escalation (handwriting / hard layouts)

**Models (ADR-0002)**
- Tiered always-on local chat (Qwen3 ladder, hardware-gated); BYOK cloud **escalation** — cost-surfaced, never silent; keys via Electron safeStorage
- First-run hardware detection + model recommendation; runtime-updatable model manifest

**Modes** (one agent loop, six configs; write-modes share: diff-preview + per-step approval + git snapshot + revert)
- **UI surfacing (ADR-0010):** the agent-sidebar mode picker exposes two top-level modes by *trust level* — **Ask** (read-only, grounded, cited) and **Agent** (write, tool loop). The specialized verbs below (Synthesize, Recall, Plan, Explain) are presets/slash-commands *within* those two modes, not sibling top-level modes. This verbs-as-presets mapping is the soft part of ADR-0010 (amendable without re-litigating the shell).
- Read: **Ask** (grounded Q&A, cites every claim), **Explain** (grounded, cited walk-through of a concept from your sources — replaces the PRD's Socratic "Tutor"; no hint-ladder/fixation scaffolding)
- Write: **Synthesize** (prompt-driven sources + confirm), **Recall** (flashcards), **Plan** (writes plan → optional "Run this plan" hands steps to Agent), **Agent** (full autonomous loop)
- **User-editable** mode JSON in `.cairn/modes/`, **behind a validation layer** — a custom mode cannot silently widen tool access or file-scope; the per-step approval gate stays the backstop

**Studio outputs** — build **one** template-driven grounded generator; ship **all 7** as templates: Study Guide · Briefing · FAQ · Timeline · **Mind Map (interactive** — collapsible, click-node-to-cite**)** · Flashcards · Quiz (interactive, wrong-answer → Explain)

**Universal UX** (good-product baseline, **always on** — not a "neurodivergent mode"): accessibility (keyboard nav, screen-reader labels, WCAG-AA contrast, `prefers-reduced-motion`); predictable UI (no surprise modals/autoplay, actions announced); readable chunked long output; on-demand **Focus mode**; "where you left off" session re-entry. The PRD §10 ND-specific mechanics (hint ladders, fixation guard, low-energy/ND toggle) are **out of scope** — see ADR-0005.

**Platform:** macOS-first (code stays portable; Windows/Linux is a later packaging + QA effort, not a rewrite)

## Deferred (genuinely post-v1)
- Tier-2 audio **output** (Audio Overview / TTS generation) — note: audio *ingestion / transcription* is **in v1** (ADR-0009)
- ~~Video nodes (need a transcription pipeline)~~ — **superseded by ADR-0009 (2026-07-07):** AV ingestion (audio + video) with timestamp citations is now in v1 (see *Sources & multi-format ingestion* above)
- Windows/Linux packaging
- Burned-in annotated-PDF export

## Build prerequisites (spikes — scaffolded, must be *run* before the dependent work)
Scaffolds written; each dir has a README + runnable stub. These are the genuine remaining unknowns — only running them resolves them.

> ⚠️ **Status (2026-06-14):** these spikes have now been run and adversarially reviewed — **4 of 5 pass their own harness but are not ADR-grade** (leaky/synthetic/narrow fixtures). Read [`spike-verdicts-correction.md`](spike-verdicts-correction.md) before citing any of them; `rag-quality` is being rebuilt.
- **Hybrid combo:** sqlite-vec + FTS5 + RRF on real chunks → `spikes/hybrid-sqlite/` *(before Phase-1 retrieval relies on hybrid)*
- **Retrieval quality:** ≥80% top-3 on a 50-Q self-test **for Qwen3-Embedding-0.6B** → `spikes/rag-quality/` *(chosen embedder unvalidated — transferred evidence only; gates the grounding promise)*
- **PDF extraction:** multi-column reading order on 2–3 real course PDFs → `spikes/pdf-extraction/`
- **Agent loop:** a real 5-step run on a local model (Qwen3-4B/8B) → `spikes/agent-loop/` *(before building the polished Agent UI)*
- **Chunk-hash embedding cache (TS):** hit-rate on a markdown edit + a re-extracted PDF → `spikes/chunk-cache-ts/`

## Engineering decisions (resolved → `docs/engineering-decisions.md`)
The build-time decisions G5–G14 are specified in [`engineering-decisions.md`](engineering-decisions.md) (DDL, signatures, the manifest shape, the revert procedure). Load-bearing ones also have ADRs:
- G5 schema · G7 embedding cache · G10 `search_notes` + coverage gate · G12 manifest · G13 hardware-detection — in `engineering-decisions.md`
- G6 chunking (512/15%) → **ADR-0006** · G8 citation anchors → **ADR-0007** · G14 agent write-safety + run-revert → **ADR-0008**
