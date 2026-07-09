# Cairn — desktop app shell (option 1a). Claude Code implementation prompt

You are implementing the main application shell for **Cairn**, a local-first, privacy-first
agentic knowledge-management desktop app (a fusion of Obsidian's Markdown vault, Cursor's
agentic editing, and NotebookLM's grounded Q&A + generated "Studio" outputs). Everything runs
locally: a local **always-on** chat model and a local **embedding** model via Ollama, with an
optional bring-your-own-key cloud model for escalation.

Build the **three-pane desktop shell** described below. `1a-reference.html` is a **low-fidelity
wireframe** of the target layout — use it to understand structure, panes, and behavior, NOT the
palette. Apply the codebase's own design system for real styling (see "Fidelity & theming").

---

## About the design file

`1a-reference.html` is a **design reference created in HTML** — a prototype of layout and behavior,
not production code to copy. Recreate this layout in the target codebase's existing environment
(React/Electron, etc.), using its established components, state, and styling patterns. If no shell
exists yet, this is the top-level app layout; Cairn's stack is Electron + a web renderer, so React
is a reasonable default.

## Fidelity & theming — READ THIS FIRST

This is a **low-fidelity wireframe**. It intentionally uses a light "paper" palette and handwritten
fonts so the structure reads clearly. **Do not ship those.** Cairn is a dark, dense IDE-style app
(think Obsidian / Cursor). Implement with:

- A **dark theme** consistent with Obsidian/Cursor: near-black panel backgrounds, muted-gray text,
  a single accent color for active/selected states. The blue accent in the wireframe (`#3763c0`)
  maps to "your app's accent"; the light selection fills map to "accent at low opacity".
- The app's **real UI font** (system UI / Inter-class), not Kalam/Caveat.
- Real **icons** from the app's icon set (Lucide/Obsidian-style line icons). The wireframe uses
  placeholder glyphs (✎ ▤ ↥ ⤢ ⟲ ⋯ ✦ etc.) — replace each with the semantically correct icon
  (edit, new-file, new-folder, sort, collapse, refresh/history, more, agent-sparkle, …).
- Use the wireframe's **measurements and layout ratios** as the spec; use your design system for
  color, type, elevation, and iconography.

---

## Layout — three panes, full-window, no gaps

A single horizontal flex row filling the window. Left and right rails are fixed-width and
resizable by dragging their inner border; the center pane flexes.

```
┌───────────────┬───────────────────────────────┬───────────────────┐
│  VAULT RAIL   │        EDITOR (center)         │  RIGHT RAIL       │
│  ~246px       │        flex: 1                 │  ~372px           │
│  (Obsidian)   │        (CodeMirror)            │  tabbed:          │
│               │                                │  Chat/Sources/    │
│               │                                │  Studio           │
└───────────────┴───────────────────────────────┴───────────────────┘
```

Reference frame: 1180×820. Vault 246px, right rail 372px, editor fills the rest. Panes are
separated by 1px dividers, no rounded corners between panes (the wireframe rounds the outer frame
only because it's a floating mock — in-app the shell is full-window).

---

## Pane 1 — Vault rail (left, Obsidian-style)

Fixed ~246px. Three vertical regions: header · scrolling file tree · footer.

**Header** — a `Vault` (or active-vault) label on the left; a row of 4 icon buttons on the right:
new note (✎), new folder (▤), change sort order (↥), collapse all (⤢). ~22px hit targets in the
wireframe — use **≥28–32px** real targets.

**File tree** (scrolls, fills height): a standard collapsible folder/file tree over the vault's
plain-Markdown folder.
- Folder rows show a disclosure caret (▸ collapsed / ▾ expanded) then the name; file (node) rows
  have no caret, indented to align.
- Nesting indent ~14px per level, with a 1px vertical guide line down each expanded group.
- The **active node** row is highlighted with an accent-tinted fill + accent text (wireframe:
  bg `#e6ecf8`, text `#274a91`, 1.4px border `#c3d1ee` → in-app: accent @ ~12% bg, accent text).
- Example content to seed with (from the real vault): folders `00-inbox`, `01-courses`,
  `02-projects`, `03-learning`, `04-references`, `05-research` (expanded), `06-cowork`,
  `attachments`, `templates`; files `AGENTS`, `CLAUDE`. Inside `05-research`: `ai-and-ml`,
  `project-supernova` (expanded → `research-papers`, `advisor-research`, `ai-agents-angle`,
  `approach-strategy` [active], `project-ideas`, `README`), `redbricklvlup`.

**Footer** — a vault switcher: a ⇕ glyph + the vault name (`New New Vault`), with help (?) and
settings (⚙) icon buttons on the right.

## Pane 2 — Editor (center, CodeMirror 6)

Fills remaining width. Three regions: tab bar · editor body · status bar.

**Tab bar** — the open node as a closable tab chip (`approach-strategy.md ✕`), then a breadcrumb
(`05-research › project-supernova`) in muted text, and a right-aligned "toggle right rail" icon (◫).
Polymorphic by node type: a `.md` node opens the Markdown editor; a PDF node opens a pdf.js viewer;
an audio/video node opens a player (out of scope for this pass, but leave the tab/host generic).

**Editor body** — CodeMirror 6 Markdown editing surface. In the wireframe the prose is placeholder
bars; render real Markdown. Two Cairn-specific inline treatments that must be modeled:

1. **`[[wikilinks]]` as inline chips** — accent-tinted pills, e.g. `[[project-ideas]]` and typed
   source links like `[[pdf: retrieval-2024 · p.4]]`. Clicking one opens that node/anchor in this
   center pane.
2. **Inline agent-edit diff hunks (ADR-0008)** — when the agent proposes an edit, it renders
   *inline in the editor*, NOT in chat. Each hunk is a bordered block with a header
   (`✦ Agent edit · hunk 2 of 3`) and per-hunk **Accept (✓, green)** / **Reject (✕, red)** buttons,
   above a diff body: removed lines on a red-tinted background (`- …`), added lines on a
   green-tinted background (`+ …`), monospace. Accept/Reject act on that hunk only.

**Status bar** — muted small text: cursor position (`Ln 42, Col 8`), syntax (`Markdown`), an
`indexed ✓` state, and right-aligned engine status (`Engine · 1,284 chunks`).

## Pane 3 — Right rail (Cursor agent + NotebookLM), TABBED

Fixed ~372px. A **tab strip** at the top switches the whole rail between three views:
**Chat** (default, active) · **Sources** · **Studio**. Active tab uses the accent treatment;
two utility icons sit at the right of the strip (refresh/new-thread ⟲, more ⋯).

### Tab: Chat (Cursor-style agent) — default
Scrolling conversation + a pinned composer.
- **User turns**: right-aligned rounded bubble, accent-tinted (wireframe `#eef1f6` bg / `#d4ddef`
  border). Example: "Wire embed.ts through the ModelProvider seam".
- **Assistant turns**: left, with a small ✦ agent avatar. Body is streamed Markdown (placeholder
  bars in the mock). Assistant messages can embed **rich blocks** — e.g. a small
  **decision/choice table** (2-col grid, thin dividers, values shown as inline code chips), and a
  **citations row**: accent-tinted pills like `model-provider.ts:14 › seam`, `ADR-0002 › escalation`.
  Every grounded claim cites a source; clicking a citation opens the anchor in the center pane
  (file:line › heading for Markdown; page/region for PDF; timestamp for AV).
- **Composer** (pinned bottom): a bordered input with placeholder `Ask, or / for a preset, @ for a
  node…` (`/` opens preset commands, `@` inserts a node as context). Below the input, a control row:
  - **Mode picker** — top-level trust modes **Ask** (read-only, grounded, cited) and **Agent**
    (write, tool loop), shown as a dropdown chip (`Agent ⌄`). The specialized verbs
    **Synthesize / Recall / Plan / Explain** are presets *inside* those two modes (surfaced via `/`),
    not sibling top-level modes.
  - **Model picker** chip (`Qwen3-4B ⌄`) — the local always-on model.
  - **Escalate** chip (`☁ escalate`, dashed/secondary) — routes the request to the optional cloud
    model; cost must be surfaced, never silent.
  - **Send** button (↑) on the right.

### Tab: Sources (NotebookLM-style)
The set of vault nodes currently in scope for grounding. A checklist of nodes, each with a
checkbox (selected = accent check), the node name, and a type chip (`MD` / `PDF` / `AV`). A header
shows the count (e.g. "4 in chat"). Toggling a source includes/excludes it from retrieval context.

### Tab: Studio (NotebookLM-style generated outputs)
A grid of **grounded output generators**, each a card (icon top-left, `›` affordance, title). Ship
Cairn's **7 templates**: **Study Guide · Briefing · FAQ · Timeline · Mind Map** (interactive —
collapsible, click-node-to-cite) **· Flashcards · Quiz** (interactive; a wrong answer → Explain).
Each generates a new grounded, cited node from the selected sources. (This replaces NotebookLM's own
card set — do not use Audio/Video Overview etc.; audio *output* is deferred in Cairn v1.)

---

## Interactions & behavior

- **Tree**: click folder → toggle expand; click node → open in center pane + set active-row
  highlight; right-click → context menu (rename/new/delete — standard vault ops).
- **Right-rail tabs**: clicking Chat/Sources/Studio swaps the rail body; remember last-active tab.
- **Editor diff hunks**: Accept applies the hunk to the buffer; Reject discards it; both advance to
  the next pending hunk. All agent writes get a diff preview + git auto-snapshot so they're
  revertible (ADR-0008).
- **Citations & wikilinks**: click → open target node/anchor in the center pane and flash the
  region (Markdown: scroll to heading/line; PDF: page + bbox highlight; AV: seek player).
- **Composer**: `/` opens preset/slash menu; `@` opens a node picker; Enter/↑ sends; mode & model
  chips open dropdowns; escalate confirms with a cost note.
- **Rail resize**: drag the inner divider of either rail; persist widths.
- **Streaming**: assistant responses stream token-by-token; show a thinking/tool-run indicator.

## State (minimum)

- `activeVaultPath`, `fileTree` (+ expanded-folder set), `activeNodeId`
- `openTabs[]` / `activeTabId` (center pane is tab-capable)
- `editorBuffer` + `pendingDiffHunks[]` (each: id, range, before/after, status)
- `rightTab` = `chat | sources | studio` (persisted)
- `chatThread[]` (turns; assistant turns carry citations + optional rich blocks), `isStreaming`
- `agentMode` = `ask | agent`, `activePreset`, `selectedModel`, `escalateEnabled`
- `sources[]` (nodeId, type, selectedForGrounding)
- `engineStatus` (indexed?, chunk count) from the engine

## Design tokens — WIREFRAME VALUES (reference only; replace with the app's dark theme)

Provided so you can read the mock; these are lofi placeholders, not final.
- Accent (active/selected/link): `#3763c0`; accent text `#274a91`; accent fill `#e6ecf8`, border `#c3d1ee`
- Diff add: text `#437a43` on `#e6f1e4`. Diff remove: text `#9c5548` on `#f7e6e2`.
- Accept button: `#3a7a3a` on `#e7f1e5` / border `#bcd6bc`. Reject: `#a35548` on `#f6e7e3` / border `#e0c2bc`.
- Muted/secondary text: `#a49d8c`–`#7d7563`.
- Radii: chips/pills ~20px (fully rounded), cards ~10px, tabs 8px top corners. 1px pane dividers.
- Type scale (map to your fonts): pane titles ~15–16px, tree rows ~15px, body/chat ~14px,
  status/meta ~12–12.5px, code/diff ~12–12.5px monospace.

## Assets
No image or font assets are required — the wireframe's Google Fonts (Kalam/Caveat) are placeholders
and should be dropped. Use the codebase's icon library for all glyphs.

## Files in this bundle
- `1a-reference.html` — standalone visual reference of the chosen layout (option 1a). Open in a browser.
- `1a-shell-spec.md` — this document (self-sufficient spec).

## Grounding references (from the Cairn repo, if available)
`docs/adr/0010` (three-pane shell), `0008` (agent write-safety / inline diffs / revert),
`0009` (sources & citation anchors), `0002` (models & escalation); `docs/v1-scope.md` (Studio
templates, modes-as-presets); `CONTEXT.md` (canonical terms: Vault, Node, Source, Index).
