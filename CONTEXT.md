# Cairn

Cairn is one product: a local-first, privacy-first **agentic knowledge-management tool** — a fusion of NotebookLM (grounded Q&A + generated outputs), Cursor (agentic editing with modes), and Obsidian (Markdown vault + graph). It is built on an internal local indexing/retrieval engine (Mneme) and adds knowledge-management surfaces (notes, chat, PDF, generated outputs) on top. It is *not* a neurodivergent study companion — see `docs/adr/0005`.

## Language

**Cairn**:
The product as a whole — the local-first agentic knowledge-management tool the user installs and uses.
_Avoid_: "the Electron app" (that names only the shell, not the product), "the tool".

**Mneme**:
Cairn's local indexing & retrieval engine — the subsystem that watches the vault, extracts and chunks documents, embeds them, and serves cited hybrid search. An internal module of Cairn, not a separately shipped product. Also acceptable: "the engine".
_Avoid_: "the RAG", "the database", "the index" (each names only one part of it).

**Vault**:
The user's folder of plain Markdown notes, imported PDFs, and other typed nodes — the source of truth and, together with its sidecar data, the app's store. Every node is plain text on disk; readable and Obsidian-compatible.
_Avoid_: "workspace", "library", "corpus" (corpus is fine for Mneme's view of it, but the user-facing concept is the vault).

**Node**:
Any addressable entity in the vault that can appear in the graph — a note, a PDF, or a flashcard (and later other media). Every node has a plain-text face on disk (a Markdown file, or a Markdown stub beside an asset), so the vault stays portable and Obsidian-readable. See `docs/adr/0003`.
_Avoid_: "file" (a node may be a stub pointing at an asset), "document", "object".

**Graph**:
Cairn's network of nodes connected by `[[wikilinks]]`. Unlike Obsidian's Markdown-only graph, Cairn's is **heterogeneous** — it links notes, PDFs, and flashcards across types — but it is a **derived view** over the wikilinks in the vault's plain files, not a separate store.
_Avoid_: "knowledge graph" (fine informally), "the network", "graph DB" (there is no graph database — see `docs/adr/0003`).

## Models

**Always-on model**:
The single chat/generation model that runs locally on the user's machine for everyday requests — chosen to fit their hardware tier and kept resident so it responds without spin-up. Cairn's default responder.
_Avoid_: "the local model" (ambiguous — the embedding model is also local), "default model".

**Embedding model**:
The local model that turns chunks and queries into vectors for retrieval. A **single app-wide default** — one model + dimension for every install, NOT tier-dependent (embedders are light enough to run on any tier). The user may switch it at any time; switching triggers a full re-index.
_Avoid_: "the embedder" is fine informally; avoid conflating it with the always-on model.

**Cloud model**:
A remote, bring-your-own-key model (e.g. Anthropic, OpenAI-compatible) the user can escalate to for significantly harder requests. Optional — never required for normal use; the app stays fully usable offline on the always-on + embedding models.
_Avoid_: "the API model", "online model".

**Escalation**:
Routing a request from the always-on model up to a cloud model when it is significantly harder than the local model handles well.

**Hardware tier**:
A bracket of student machine capability (roughly: RAM/unified memory + GPU/Apple-Silicon class) that determines which **always-on chat model** Cairn recommends. It does NOT determine the embedding model (that is a single app-wide default). See `docs/model-strategy.md` for the tier table.

## Storage

**Index**:
The derived store of embeddings + keyword index (sqlite-vec + FTS5 + metadata) under `.cairn/`. It is **disposable and rebuilt from the vault on demand**, and is **per-machine — never synced**. The vault is the source of truth; the index is a cache of it.
_Avoid_: "the database" (the vault is the real store), "the vector DB" (it holds vector + keyword + metadata together).

**Re-index**:
Rebuilding the index from the vault — a first-class, user-triggerable operation (e.g. after the user switches the embedding model). Because the vault is portable plain files and the index is disposable, switching embedders is always safe: re-indexing reuses cached extraction/chunking where it can but re-embeds (the embedding cache is keyed by model + dimension).
