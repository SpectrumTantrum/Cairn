# PRD: Cairn — Local-First AI Study Companion
**Name:** Cairn
**Author:** Torres · **Date:** June 2026 · **Status:** v1.0 — ready for AI-assisted implementation
**One-liner:** NotebookLM + Cursor + Obsidian, fused into one local-first desktop app for students — grounded AI over your own notes and PDFs, agentic editing with education-tailored modes, and native PDF annotation.

---

## 1. Vision & Problem

Students (especially neurodivergent students) juggle three disconnected tools:
- **Obsidian** for linked markdown notes — but its AI story is bolted-on and its PDF annotation is weak.
- **NotebookLM** for grounded Q&A, study guides, mind maps — but it is cloud-only, sources are siloed per notebook, and your data lives on Google's servers.
- **Cursor** for agentic AI editing — but it is built for code, not knowledge, and it is closed-source.

**Cairn** combines the three: a local markdown vault with wikilinks and graph (Obsidian DNA), an agent with task-scoped modes that can read/write the vault (Cursor DNA), grounded study outputs generated strictly from the user's own sources with citations (NotebookLM DNA), and a first-class PDF reader with annotation — all running locally, with bring-your-own-model (local via Ollama, or BYOK cloud APIs).

**Primary differentiator:** every existing tool in this space targets researchers (Zotero AI plugins) or generic PKM (Khoj, Open Notebook). None target *students learning material*, and none are designed around neurodivergent-friendly pedagogy (chunking, hint ladders, active recall, fixation prevention, low-energy modes). That pedagogy layer is the product's identity, not an add-on.

## 2. Goals & Non-Goals

### Goals (v1)
1. Local markdown vault: edit, wikilink, backlink, tag, graph-view notes. Obsidian-vault-compatible on disk (plain `.md` + `[[wikilinks]]` + YAML frontmatter) so users can point it at an existing Obsidian vault.
2. Local RAG over the vault and imported PDFs: semantic search with citations that jump to the exact source chunk.
3. Agent with six education-tailored modes (Ask, Tutor, Synthesize, Recall, Plan, Agent), each = system prompt + tool whitelist + file-scope rules.
4. Native PDF reading and annotation (highlights, notes, area annotations) stored locally and linkable from markdown notes.
5. Grounded "Studio" outputs generated from selected sources: Study Guide, Briefing, FAQ, Timeline, Mind Map, Flashcards, Quiz.
6. Model-agnostic: Ollama (local) and OpenAI-compatible / Anthropic APIs (BYOK). No vendor lock-in. App must be fully usable 100% offline with local models.
7. Safety rails: git-backed vault snapshots, per-step approval for write/command actions, scoped file permissions per mode.
8. Accessibility-first UX for ADHD/autistic users (see §10).

### Non-Goals (v1)
- ❌ Forking VSCode or any full editor (maintenance burden; loses nothing of value).
- ❌ Real-time collaboration / multi-user sync.
- ❌ Mobile apps.
- ❌ Video Overview generation (Tier 3 — see §12 Future).
- ❌ Cloud accounts, telemetry, or any server-side component. Zero data leaves the machine unless the user configures a cloud model API.
- ❌ Code execution / terminal-centric workflows (this is a knowledge tool, not an IDE).
- ❌ Reproducing copyrighted textbook content; outputs are grounded in the user's own files.

## 3. Target Users & Personas

**P1 — "Torres" (primary):** CS sophomore, ADHD + autistic. Takes lecture notes in markdown, gets course PDFs (slides, problem sets, papers). Wants: upload week's materials → get chunked explanations, quizzes for active recall, a study guide before exams — without uploading coursework to a cloud service. Comfortable with Ollama and API keys.
**P2 — Non-technical student:** Wants the same outcomes with zero setup. Needs first-run flow that offers a one-click local model download OR a paste-an-API-key path.
**P3 — Self-directed learner:** Building knowledge across books/PDFs/web clippings over years; cares about the compounding vault and graph more than courses.

## 4. Foundation Decision (explicit, with rationale)

**Build a standalone desktop app: Electron + React + TypeScript.** Do not fork VSCode, Obsidian (not open source — cannot be forked), or Zotero.

Rationale recorded for posterity:
- The team's existing skills are React/TS — Electron maximizes velocity.
- The app needs three first-class surfaces (markdown editor, PDF annotator, chat/agent panel) that no single fork-able base provides together; gluing them as plugins into someone else's app caps the product ceiling.
- Electron gives Node in the main process → easy local file watching, SQLite, git, and child-process model servers. pdf.js (Apache-2.0) is battle-tested in Electron.
- **Tauri is the sanctioned alternative** if bundle size/RAM become priorities; keep all app logic in the React renderer + a thin IPC layer so a Tauri port stays feasible. Implementation AI: structure code with this portability in mind.

**License policy:** App license MIT or Apache-2.0. Only permissively-licensed dependencies (MIT/Apache/BSD/MPL). **Do not copy code from AGPL projects** (Obsidian plugins vary; SiYuan, Logseq, Zotero are AGPL/GPL) — use them as design references only.

## 5. System Architecture

```
┌────────────────────────── Electron Renderer (React + TS) ──────────────────────────┐
│  Vault Explorer │ Markdown Editor │ PDF Reader+Annotator │ Chat/Agent Panel │ Studio │
│  (file tree,    │ (CodeMirror 6,  │ (pdf.js viewer +      │ (mode picker,    │ (study │
│   tags, graph)  │  live preview,  │  highlight layer,     │  streaming chat, │ guide, │
│                 │  [[wikilinks]]) │  annotation sidebar)  │  approval cards) │ quiz…) │
└───────────────────────────────▲─────────────────────────────────────────────────────┘
                                │ typed IPC (contextBridge; no nodeIntegration)
┌───────────────────────────────▼───────────────── Electron Main (Node) ──────────────┐
│ Vault Service        Index Service           Agent Orchestrator      Model Gateway  │
│ • fs read/write      • chokidar watcher      • mode registry         • Ollama HTTP  │
│ • git snapshots      • md/pdf chunkers       • tool registry          (chat+embed)  │
│   (isomorphic-git    • embeddings → SQLite   • tool-call loop        • OpenAI-compat│
│    or system git)    • sqlite-vec ANN search • approval gating       • Anthropic    │
│ • link graph index   • citation resolver     • run log (JSONL)       • streaming    │
└──────────────────────────────────────────────────────────────────────────────────────┘
Disk layout (the vault IS the database; app state lives beside it):
  vault/                          ← user's notes, plain .md (Obsidian-compatible)
  vault/.cairn/index.db      ← SQLite: chunks, embeddings (sqlite-vec), file hashes
  vault/.cairn/annotations/  ← one JSON per PDF (see §8)
  vault/.cairn/runs/         ← agent run logs (JSONL, append-only)
  vault/.git/                     ← auto-initialized snapshot history
  vault/assets/pdfs/              ← imported PDFs (originals never modified)
```

**Key principles for the implementation AI:**
- Plain files first: a user must be able to delete the app and keep 100% of their notes/annotations readable.
- Renderer never touches `fs` directly; all file/model/git access through typed IPC handlers.
- Everything async + streaming; the UI must never block on indexing or model calls.
- All model calls go through one `ModelGateway` interface (`chat(messages, tools?, stream)` / `embed(texts)`) so providers are swappable per-task (e.g., local embeddings + cloud chat).

## 6. RAG / Indexing Pipeline (the core — build this first)

1. **Watch:** chokidar on the vault; debounce; re-index only changed files (store content hash per file).
2. **Chunk:**
   - Markdown: split by heading hierarchy (H1–H3), max ~800 tokens per chunk, 100-token overlap; each chunk records `{file, heading_path, start_line, end_line}`.
   - PDF: extract per-page text via pdf.js (`getTextContent`); chunk per page → sub-chunk if >800 tokens; record `{file, page, char_range}`. (OCR for scanned PDFs is out of scope v1; detect empty-text pages and warn.)
3. **Embed:** default `nomic-embed-text` (or `mxbai-embed-large`) via Ollama; cloud embedding optional. Store vectors in SQLite via `sqlite-vec`. Single-file DB, no server — chosen deliberately over Chroma/LanceDB for zero-setup.
4. **Retrieve:** `search_notes(query, k=8, filter?)` → embed query → ANN search → return chunks with metadata + similarity. Hybrid bonus (v1.1): merge with SQLite FTS5 keyword results (reciprocal rank fusion).
5. **Cite:** every retrieved chunk has a stable citation token `[[cite:file#anchor]]` (heading anchor or `p.N` for PDFs). Chat answers must render citations as clickable chips that open the source: markdown → scroll to heading/line; PDF → open at page and flash the region.

**Acceptance criteria:** indexing 1,000 notes + 50 PDFs completes in background without UI jank; a question whose answer exists in the vault returns the correct chunk in top-3 ≥80% of the time on a 50-question self-test set; every claim in an Ask answer carries ≥1 clickable citation; clicking lands within one heading/page of the source.

## 7. Agent & Modes

One agent loop (LLM tool-calling: model proposes tool call → gate → execute → feed result back → repeat, max 25 steps), six mode configs. A mode = `{name, system_prompt, allowed_tools[], file_scope, requires_approval}`. Modes are user-editable JSON in `vault/.cairn/modes/` — custom modes are a feature, not just config.

**Tool registry:** `search_notes(query)`, `read_note(path)`, `write_note(path, content)` (diff-preview + approval), `list_files(glob)`, `get_pdf_annotations(pdf)`, `create_flashcards(deck, cards[])`, `generate_studio(type, sources[])`, `get_backlinks(path)`.

| Mode | Purpose | Tools | Scope / rules |
|---|---|---|---|
| **Ask** | Grounded Q&A, NotebookLM-style | search_notes, read_note, get_pdf_annotations | Read-only. Must cite every claim. Must say "your notes don't cover this" rather than answer from general knowledge (offer ungrounded answer behind an explicit toggle). |
| **Tutor** | Socratic + direct teaching | search_notes, read_note | Read-only. Chunked explanations (one concept per message), comprehension check after each chunk, 3-level hint ladder before revealing solutions, never dumps the full answer to graded work. |
| **Synthesize** | Cross-note connection finding; writes new linked notes | search_notes, read_note, write_note, get_backlinks | Writes only new files under `synth/` unless user approves edits elsewhere. Always adds `[[wikilinks]]` + frontmatter. |
| **Recall** | Active-recall material | search_notes, read_note, create_flashcards, write_note | Writes only under `recall/`. Generates cloze + Q/A cards, spaced-repetition-ready (include Anki-importable TSV export). |
| **Plan** | Break projects/study goals into chunked, time-boxed steps | search_notes, read_note, write_note | Writes only `plans/*.md`. Steps must be small (≤25-min "one sitting" chunks), each with a concrete "done when" criterion. |
| **Agent** | Autonomous multi-step vault work (reorganize, build study guide across 8 notes, fill stub gaps) | all tools | Full scope. HARD GATES: auto `git commit` snapshot before run; every write/delete shows a diff card requiring approval (no global auto-approve in v1); run log to `runs/`; "revert this run" button = git revert. |

**Mode prompts** live as versioned markdown templates in-repo; each includes the neurodivergent-pedagogy rules (§10) as a shared partial.

**Acceptance criteria:** switching modes visibly changes available tools (UI shows the whitelist); Tutor never reveals a final answer before hint level 3; Agent mode cannot write without an approval click; a reverted Agent run restores the vault byte-identical.

## 8. PDF Reading & Annotation (first-class surface)

- **Viewer:** pdf.js (Apache-2.0). Continuous scroll, zoom, page thumbnails, text selection, in-PDF search.
- **Annotations:** text highlights (5 colors), margin notes attached to highlights, area/rectangle annotations (for diagrams), free-page notes.
- **Storage:** sidecar JSON per PDF at `.cairn/annotations/<sha256-of-pdf>.json`:
  `{pdf, page, type, color, rects[], quote, note, created, id}` — original PDF is never modified (export "burned-in" annotated copy via pdf-lib is a v1.1 nicety).
- **Vault integration (the differentiating part):**
  - Every annotation gets a stable link `[[pdf:<file>#<annotation-id>]]`; pasting it in a note creates a clickable backlink; the PDF sidebar shows "referenced in N notes."
  - "Extract annotations to note" → generates a markdown note with all highlights as quotes + links back to exact locations (Zotero-style, but into the vault).
  - Annotations and their quoted text are indexed in RAG (chunk type `annotation`), so Ask answers can cite *the user's own highlights* preferentially.
  - In-reader AI: select text → context menu → "Explain (Tutor)" / "Ask about this" / "Add to flashcards (Recall)" — selection is injected as context, response opens in the chat panel.
- **Acceptance criteria:** highlight a sentence → it persists across restarts; clicking a `[[pdf:…]]` link opens the PDF scrolled to the highlight with a flash effect; extracted-annotation notes round-trip (links resolve); selection→Tutor responds using the selected text.

## 9. Studio Outputs (NotebookLM-tier features, prioritized by build cost)

All Studio generators take an explicit **source set** (user multi-selects notes/PDFs/folders) and must ground strictly in those sources with citations. Tier 1 only in v1.

**Tier 1 (v1 — prompts over the existing RAG engine):**
- **Study Guide** — sectioned summary + key terms + likely exam questions → writes `studio/study-guide-<topic>.md`.
- **Briefing / FAQ / Timeline** — same pattern, different templates. Timeline renders with Mermaid.
- **Mind Map** — LLM extracts concept hierarchy as JSON tree → render interactively (collapsible nodes, click-node-to-see-source-citations); also export as Mermaid `mindmap` block in a note. The vault's wikilink graph view (vault-wide) is separate from per-source-set mind maps (generated).
- **Flashcards & Quiz** — quiz = in-app interactive (multiple choice + short answer, immediate feedback, "explain why I got this wrong" hands off to Tutor with the question as context).

**Tier 2 (v1.5, behind a flag):** **Audio Overview** — two-host dialogue script (prompt) → TTS. Local: Piper/Kokoro; optional cloud TTS BYOK. Ship script-generation first (readable dialogue note has study value alone), audio second. Quality will not match NotebookLM's proprietary TTS — acceptable.

**Tier 3 (explicitly future, not in this PRD's scope):** Video Overviews.

**Acceptance criteria:** every Studio artifact is a plain file in the vault (no proprietary store); every factual line in a study guide carries a citation chip; mind-map nodes open their source chunks; quiz wrong-answers can hand off to Tutor in one click.

## 10. Neurodivergent-First UX Requirements (product identity — not optional polish)

1. **Chunking everywhere:** Tutor/Studio output arrives in small sections with explicit "continue?" affordances; never wall-of-text by default.
2. **Hint ladders:** 3 escalating hint levels before any solution reveal (Tutor, Quiz).
3. **Low-energy mode:** global toggle → shorter responses, smaller task chunks, gentler pacing, reduced visual density. Persisted.
4. **Fixation guard:** if a Tutor/quiz session loops >15 min on one concept without progress, the agent proactively offers: take a break / switch approach / park it in a "stuck list" note.
5. **Focus mode:** hide everything but the current pane; optional 25-min timer with break prompts (no shame language on overruns).
6. **Predictability:** no surprise modals, no auto-playing media, no layout shift; every agent action announced before it happens; `prefers-reduced-motion` respected; all flash/scroll effects subtle.
7. **Session re-entry:** on reopen, a "where you left off" card (last note, last PDF page, open quiz) — externalized working memory.
8. **Full keyboard navigation + screen-reader labels;** WCAG 2.1 AA contrast in both themes.
9. **Tone rules in all prompts:** no condescension, no toxic positivity, direct language, celebrate completion concretely.

## 11. Settings, Models & First-Run

- First-run wizard: pick/create vault folder (or point at existing Obsidian vault) → choose model path: (a) "Local & private" — detect Ollama, offer model pulls (chat: e.g. `qwen3:8b`-class; embed: `nomic-embed-text`), or (b) "Bring my own key" — Anthropic / OpenAI-compatible base URL + key (stored in OS keychain via `keytar`-equivalent, never plaintext).
- Per-task model assignment (chat vs. embeddings vs. TTS). Show token/cost estimates for cloud calls.
- Privacy statement in-app: no telemetry, no network calls except user-configured model endpoints; an in-app network log proves it.

## 12. Build Phases (each phase ends usable; AI implementer: do not start phase N+1 with phase N acceptance criteria failing)

- **Phase 0 — Vault shell (week 1–2):** Electron+React+TS scaffold, vault open/create, file tree, CodeMirror markdown editing, wikilink autocomplete + backlinks panel, git auto-snapshot on save.
- **Phase 1 — RAG core (week 2–4):** indexer + sqlite-vec + `search_notes`, semantic search UI, citation chips with jump-to-source. *This is the heart; over-invest in retrieval quality and the citation UX.*
- **Phase 2 — Chat + Ask & Tutor (week 4–6):** ModelGateway (Ollama + Anthropic + OpenAI-compat, streaming), chat panel, Ask + Tutor modes, grounded-with-citations answers.
- **Phase 3 — Write modes (week 6–8):** tool-call loop with diff-preview approvals; Synthesize, Recall, Plan; Anki TSV export.
- **Phase 4 — PDF surface (week 8–11):** pdf.js viewer, annotations + sidecar storage, `[[pdf:]]` links, annotation extraction, annotation indexing, selection→Tutor.
- **Phase 5 — Studio Tier 1 + Agent mode (week 11–14):** Study Guide/FAQ/Timeline/Briefing, interactive mind map, quiz UI, full Agent mode with git-gated runs.
- **Phase 6 — ND-UX hardening + packaging (week 14–16):** §10 toggles, first-run wizard, keychain, builds for macOS (priority), Windows, Linux.

## 13. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Crowded space (Khoj, Open Notebook, Zotero AI plugins, Obsidian AI plugins) | Differentiate on pedagogy + PDF-annotation↔vault integration; ship the student story, not generic "chat with docs". |
| Local model quality varies on student hardware | Per-task model routing; honest defaults; BYOK escape hatch; retrieval quality reduces dependence on model brilliance. |
| Agent corrupts notes | Git snapshots + mandatory diff approvals + one-click run revert (§7). |
| pdf.js annotation layer complexity | Sidecar-JSON design keeps PDFs untouched; cut area-annotations before cutting highlights if needed. |
| Scope creep (audio/video) | Tiered Studio plan; Tier 2 behind flag; Tier 3 out of scope. |
| Solo-dev burnout | Phases each end usable; the app becomes the dev's own daily study tool from Phase 2 onward (dogfooding = motivation). |

## 14. Success Metrics (v1, personal-scale)
- Builder uses it as the primary study tool for one full course unit (replaces Obsidian+ChatGPT-tab workflow).
- "Week of materials → study guide + quiz" flow completes in <10 minutes end-to-end on local models.
- ≥80% top-3 retrieval on the 50-question vault self-test; zero un-cited claims in Ask answers during a week of dogfooding.
- An Agent-mode run on a 200-note vault produces zero unapproved writes and survives revert.

## 15. Open Questions (decide during build, do not block start)
1. Tauri port timing (after v1 ships, if RAM/bundle complaints materialize).
2. Hybrid keyword+vector retrieval in v1 or v1.1.
3. Spaced-repetition scheduling in-app vs. delegating to Anki export only.
4. Whether modes should also be exposed as MCP server so external agents (Claude Code etc.) can drive the vault.
5. Name: "Cairn" chosen — verify domain/trademark/existing-product availability before any public release.

## Appendix A — Reference prior art (design references ONLY; respect §4 license policy)
NotebookLM (Studio outputs, grounding UX) · Cursor (mode UX, diff approvals) · Obsidian (vault/graph/wikilinks UX) · Cline/Roo/Kilo (open agent-loop + mode architecture, Apache-2.0 — safe to study) · Khoj / Open Notebook / AnythingLLM (local RAG patterns) · Zotero + llm-for-zotero / Beaver (PDF annotation + grounded-citation-jump UX; AGPL — do not copy code).
