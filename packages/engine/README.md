# @cairn/engine — local-first grounded retrieval (MVP CLI)

The headless indexing & retrieval engine behind [Cairn](../../CONTEXT.md) (a.k.a. **Mneme**),
shipped first as a tiny CLI tracer. Point it at a folder of Markdown; it chunks, indexes,
and answers **grounded, cited** queries over your own notes — fully local, no telemetry, no
cloud. This is the spine the eventual desktop app sits on (ADR-0001: the engine is headless
and CLI-testable by design).

> **Status: MVP tracer.** It does `index` + `search`. It is also the honest harness for
> rebuilding the retrieval eval — see [`docs/spike-verdicts-correction.md`](../../docs/spike-verdicts-correction.md).
> Dense-retrieval *quality* is not yet independently validated (the prior eval was lexically
> leaky); the keyword arm carries real weight, which is why a zero-model `--lexical` mode exists.

## Requirements

- **Node ≥ 23.6** (runs TypeScript directly — no build step).
- **Hybrid mode (default):** a local [Ollama](https://ollama.com) on `localhost:11434` with an
  embedder pulled: `ollama pull qwen3-embedding:0.6b`.
- **Lexical mode (`--lexical`):** nothing else — keyword search with zero model setup.

## Install

```bash
cd packages/engine
npm install
```

## Use

```bash
# Hybrid (dense + keyword + RRF) — needs Ollama + the embedder
node src/cli.ts index /path/to/notes
node src/cli.ts search "spaced repetition" --in /path/to/notes -k 5

# Lexical only — no model, runs anywhere
node src/cli.ts index /path/to/notes --lexical
node src/cli.ts search "spaced repetition" --in /path/to/notes

# Optional: install the `cairn` command globally
npm link
cairn index /path/to/notes
cairn search "your question" --in /path/to/notes
```

The index lives in `/path/to/notes/.cairn/index.db` — **disposable and per-machine**; the
Markdown files are the source of truth. Re-running `index` rebuilds it, re-embedding only the
chunks whose content changed (content-addressed embedding cache).

## What it does (and doesn't)

- **Does:** recursive 512-token/15%-overlap chunking (G6); `(chunk_hash, embedder, dim)`
  embedding cache (G7); sqlite-vec dense KNN + FTS5 keyword, fused with RRF (G10); fuzzy
  citation anchors back to `file:line › heading` (ADR-0007).
- **Doesn't (yet):** generated answers (`ask`), PDFs, the graph, the GUI, agent modes — those
  are the wider v1 in [`docs/v1-scope.md`](../../docs/v1-scope.md).

## Layout

```
src/
  cli.ts         argument parsing + output
  indexer.ts     walk → chunk → embed (cache-aware) → store
  chunk.ts       structure-aware chunking + citation provenance
  normalize.ts   G6/G7 normalization + content-addressed hash
  embed.ts       Ollama /api/embed
  store.ts       sqlite-vec + FTS5 + embedding cache (under .cairn/)
  retrieve.ts    FTS sanitize + RRF fuse + hybrid/lexical search
```
