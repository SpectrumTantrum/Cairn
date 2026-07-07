# Heterogeneous node graph over plain files (not a native graph DB)

Cairn's graph connects more than Markdown notes: it links **typed nodes** — notes, PDFs, flashcards (and later other media) — across types. But every node still has a **plain-text face on disk** (a `.md` file, or a small Markdown stub beside an asset), edges remain `[[wikilinks]]`, and the typed graph is a **derived index** under `.cairn/`, rebuilt from those wikilinks. We deliberately keep the "plain files / Obsidian-compatible / delete-the-app-and-keep-everything-readable" invariant rather than adopting a native graph database, even though the product's graph is richer than Obsidian's markdown-only one.

## Considered options

- **Native graph database** (nodes and cross-type edges as first-class records in a graph store): the richest model and the most natural fit for "connect anything to anything," but it makes the graph — not the vault — the source of truth. The vault stops being portable and Obsidian-readable on its own, breaking the invariant that is Cairn's reason to exist (CONTEXT.md: "the vault IS the database; the index is derived"). Rejected.
- **Plain-files graph (chosen):** every node is representable as text; edges are wikilinks; the graph is a derived, disposable view. Obsidian-compatibility and "delete the app, keep your notes" both survive.

## Consequences

- **Every node type must have a plain-text representation.** Flashcards are `.md` files with YAML frontmatter (human-readable, Obsidian-visible — not rows in a binary store). Media (later) is a Markdown stub carrying frontmatter + transcript, with the binary asset in `assets/`. A node type that cannot be represented as text does not belong in the vault.
- **The typed graph lives in `.cairn/` and is rebuilt from wikilinks** — disposable and per-machine, consistent with ADR-0001/CONTEXT.md's "index is derivative of the vault."
- **Cross-type edges still render in Obsidian** as plain wikilinks (Cairn's type semantics are lost there, but the link is not — degraded, not broken).
- **v1 node types: `note`, `pdf`, `flashcard`.** Video is deferred (it needs a transcription pipeline — Whisper-class model, new dependency + license check, asset storage), but the node model is type-extensible so video slots in later **without a migration**. — **Superseded by ADR-0009 (2026-07-07):** video/AV is now a v1 node type (local whisper.cpp transcription + timestamp citations); the type-extensible model let it slot in without a migration, exactly as anticipated here.
