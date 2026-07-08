# @cairn/engine — local-first grounded retrieval

The headless indexing & retrieval engine behind [Cairn](../../CONTEXT.md) (a.k.a. **Mneme**).
Point it at a folder of Markdown; it chunks, indexes, and answers **grounded, cited** queries
over your own notes — fully local, no telemetry, no cloud. This is the spine the desktop app
sits on (ADR-0001: the engine is headless and CLI-testable by design).

> **Status.** Hybrid retrieval (sqlite-vec dense KNN + FTS5 keyword, fused with RRF) backs both
> single-turn `ask()` and a multi-turn, token-streaming `ChatThread` — both grounded and cited,
> with a "not in your notes" refusal gate. Scoped retrieval (restrict to a subset of sources),
> per-call model selection, and a wikilinks module (parse/resolve/backlinks, ADR-0003) round out
> the programmatic API; the `cairn` CLI (`index` / `search` / `ask`) is one consumer of it. It is
> also the honest harness for rebuilding the retrieval eval — see
> [`docs/spike-verdicts-correction.md`](../../docs/spike-verdicts-correction.md). Dense-retrieval
> *quality* is not yet independently validated (the prior eval was lexically leaky); the keyword
> arm carries real weight, which is why a zero-model `--lexical` mode exists.

## Requirements

- **Node ≥ 20**.
- **Hybrid mode (default):** a local [Ollama](https://ollama.com) on `localhost:11434` with an
  embedder pulled: `ollama pull qwen3-embedding:0.6b`.
- **`ask` (grounded answers):** also a local chat model — `ollama pull qwen3:4b`.
- **Lexical mode (`--lexical`):** nothing else — keyword search with zero model setup.

## Install

```bash
cd packages/engine
npm install
npm run build
```

## Development vs production execution

During development, `npm run typecheck` validates the TypeScript sources in `src/`.
For production use by the desktop app or the `cairn` CLI, run `npm run build`
and import/execute the emitted JavaScript in `dist/`. The package entrypoint,
types, and CLI bin all point at `dist/` so consumers do not rely on raw
TypeScript execution.

## Use

```bash
# Hybrid (dense + keyword + RRF) — needs Ollama + the embedder
node dist/cli.js index /path/to/notes
node dist/cli.js search "spaced repetition" --in /path/to/notes -k 5

# Ask a grounded, cited question (needs a chat model: ollama pull qwen3:4b)
node dist/cli.js ask "how does the embedding cache stay cheap on edits?" --in /path/to/notes

# Lexical only — no model, runs anywhere
node dist/cli.js index /path/to/notes --lexical
node dist/cli.js search "spaced repetition" --in /path/to/notes

# Optional: install the `cairn` command globally
npm link
cairn index /path/to/notes
cairn ask "your question" --in /path/to/notes
```

`ask` answers **only** from your notes — every claim cites a `[n]` source, and it replies
*"Your notes don't cover this"* rather than guess when retrieval comes up empty.

The index lives in `/path/to/notes/.cairn/index.db` — **disposable and per-machine**; the
Markdown files are the source of truth. Re-running `index` rebuilds it, re-embedding only the
chunks whose content changed (content-addressed embedding cache).

## Programmatic API (beyond the CLI)

The engine exposes a few in-process seams the desktop shell drives directly. All are
backward-compatible additions — the single-turn `ask()` and `search()` signatures still
work unchanged (new fields are optional).

- **Per-call model selection.** `ask(index, q, { model })` and `ChatThread.send(text, { model })`
  pick any pulled Ollama chat model per request; omit it and `resolveChatModel()` falls back
  to the internal default (Qwen3 preferred). An unavailable model rejects with a clear error.
- **Multi-turn grounded chat.** `new ChatThread(index, { mode?, model?, scope?, k? })` holds
  ordered messages; `send(text, opts?)` runs grounded retrieval on the new turn, calls the
  model with prior history + the retrieved SOURCES block, and returns the same
  `grounded/covered/sources` metadata `ask()` returns — including the "Your notes don't cover
  this." refusal. Single-turn `ask()` is untouched.
- **Streaming.** Pass `send(text, { onToken })` (or call `chatStream(model, messages, { onToken })`)
  to receive tokens as the model produces them; the Promise still resolves to the full answer.
  Streaming rides the `ModelProvider` seam (`chatStream`, implemented by `OllamaClient` via
  `/api/chat` `stream:true`), so an Electron IPC bridge can forward each token — the engine
  itself stays HTTP/DOM-free. Providers without `chatStream` degrade to a one-shot emit.
- **Scoped retrieval.** `search`/`ask`/`ChatThread.send` accept `scope?: string[]` — an
  include-list of vault-relative paths that restricts retrieval to a subset of sources (powers
  a Sources tab). Enforced by over-fetching the full ranked pool and filtering before top-k, so
  a small scope never starves results (sqlite-vec is a brute-force scan at v1 scale anyway).
  Omitted/empty = whole index. Coverage/refusal is computed over the scoped subset.
- **Wikilinks (ADR-0003).** `parseWikilinks(md)`, `resolveWikilink(target, files)` (Obsidian
  rules: exact path > unique basename > unresolved + ambiguity list), and
  `computeBacklinks(path, docs)` / `buildBacklinkIndex(docs)` — pure functions over
  vault-relative paths/docs (the persistence seam doesn't enumerate files).

## What it does (and doesn't)

- **Does:** recursive 512-token/15%-overlap chunking (G6); `(chunk_hash, embedder, dim)`
  embedding cache (G7); sqlite-vec dense KNN + FTS5 keyword, fused with RRF (G10);
  Qwen3 query instruction-prefixing while stored chunks stay un-prefixed; fuzzy citation
  anchors back to `file:line › heading` (ADR-0007); `ask` — grounded, cited answers from a
  local chat model, with a "not in your notes" refusal gate.
- **Doesn't (yet):** PDFs, the graph, the GUI, agent write-modes — those are the wider v1 in
  [`docs/v1-scope.md`](../../docs/v1-scope.md).

## Layout

```
src/
  cli.ts         argument parsing + output (index / search / ask)
  indexer.ts     walk → chunk → embed (cache-aware) → store
  chunk.ts       structure-aware chunking + citation provenance
  normalize.ts   G6/G7 normalization + content-addressed hash
  embed.ts       Ollama /api/embed
  store.ts       sqlite-vec + FTS5 + embedding cache (under .cairn/)
  retrieve.ts    FTS sanitize + RRF fuse + hybrid/lexical search
  chat.ts        Ollama /api/chat (the always-on model)
  ask.ts         grounded, cited answer over retrieved chunks
```
