#!/usr/bin/env node
// cairn — the headless CLI face of the Mneme engine (ADR-0001). Two commands:
//   cairn index  <folder> [--lexical] [--embedder <tag>]
//   cairn search <query...> [--in <folder>] [-k <n>] [--lexical]

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { indexVault } from "./indexer.ts";
import { search } from "./retrieve.ts";
import { Store } from "./store.ts";

const HELP = `cairn — local-first grounded retrieval over a Markdown folder

USAGE
  cairn index  <folder> [--lexical] [--embedder <tag>]
  cairn search <query...> [--in <folder>] [-k <n>] [--lexical]

COMMANDS
  index   Chunk + index every .md/.markdown file under <folder> into <folder>/.cairn/.
          Hybrid (dense + keyword) by default — needs Ollama + an embedder pulled.
          --lexical builds a keyword-only index (no model, zero setup).
  search  Return ranked, cited chunks (file:line › heading) for a query. Auto-uses
          hybrid when the index has vectors and Ollama is up; else keyword-only.

EXAMPLES
  cairn index ./notes
  cairn index ./notes --lexical
  cairn search "spaced repetition" --in ./notes -k 5
`;

interface Parsed {
  flags: Record<string, string | boolean>;
  positional: string[];
}

function parseArgs(args: string[]): Parsed {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--lexical") flags.lexical = true;
    else if (a === "--embedder") flags.embedder = args[++i];
    else if (a === "--in") flags.in = args[++i];
    else if (a === "-k") flags.k = args[++i];
    else if (a.startsWith("--")) flags[a.slice(2)] = args[++i] ?? true;
    else positional.push(a);
  }
  return { flags, positional };
}

async function runIndex(p: Parsed): Promise<void> {
  const folder = resolve(p.positional[0] ?? ".");
  const lexical = !!p.flags.lexical;
  process.stderr.write(`Indexing ${folder} (${lexical ? "lexical" : "hybrid"})…\n`);
  const t0 = Date.now();
  const stats = await indexVault(folder, {
    lexical,
    embedder: typeof p.flags.embedder === "string" ? p.flags.embedder : undefined,
  });
  const ms = Date.now() - t0;
  console.log(`Indexed ${stats.files} files → ${stats.chunks} chunks  [${stats.mode}]`);
  if (stats.mode === "hybrid") {
    console.log(`  embedder ${stats.embedder} (${stats.dim}-dim) · embedded ${stats.embedded} · cache-reused ${stats.cached}`);
  }
  console.log(`  index at ${folder}/.cairn/index.db · ${ms} ms`);
}

async function runSearch(p: Parsed): Promise<void> {
  const root = resolve(typeof p.flags.in === "string" ? p.flags.in : ".");
  if (!existsSync(`${root}/.cairn/index.db`)) {
    console.error(`No index at ${root}/.cairn — run \`cairn index ${root}\` first.`);
    process.exit(1);
  }
  const query = p.positional.join(" ").trim();
  if (!query) {
    console.error("Empty query. Usage: cairn search <query...>");
    process.exit(1);
  }
  const k = typeof p.flags.k === "string" ? Math.max(1, parseInt(p.flags.k, 10) || 8) : 8;
  const store = new Store(root);
  const { hits, mode } = await search(store, query, { k, mode: p.flags.lexical ? "lexical" : "auto" });
  store.close();

  if (hits.length === 0) {
    console.log(`No results for ${JSON.stringify(query)}  [${mode}]`);
    return;
  }
  console.log(`\n${hits.length} result${hits.length > 1 ? "s" : ""} for ${JSON.stringify(query)}  [${mode}]\n`);
  hits.forEach((h, i) => {
    const loc = h.heading ? `${h.file}:${h.line} › ${h.heading}` : `${h.file}:${h.line}`;
    const sc = Number.isFinite(h.score) && h.score > 0 ? `  (${h.score.toFixed(4)} ${h.arms})` : "";
    console.log(`${String(i + 1).padStart(2)}. ${loc}${sc}`);
    console.log(`    ${h.snippet}\n`);
  });
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const parsed = parseArgs(rest);

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }
  if (cmd === "index") return runIndex(parsed);
  if (cmd === "search") return runSearch(parsed);

  console.error(`Unknown command: ${cmd}\n`);
  console.log(HELP);
  process.exit(1);
}

main().catch((err) => {
  console.error(`\nError: ${err?.message ?? err}`);
  process.exit(1);
});
