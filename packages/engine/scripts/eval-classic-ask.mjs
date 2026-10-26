#!/usr/bin/env node
// Headless classic Ask eval. One JSONL row per question.
// `answer` is the text classic Ask shows. `band` is strong, weak, below, or lexical.
//
//   node packages/engine/scripts/eval-classic-ask.mjs \
//     --vault /path/to/vault \
//     --questions /path/to/questions.csv \
//     --out /tmp/cairn-eval.jsonl \
//     [--model <tag>] [--gate current|legacy] [--temperature <n>] [--seed <n>]
//
// CSV header: id,bucket,question,gold_file
// Indexes the vault (hybrid) when <vault>/.cairn/index.db is missing.
// A second run with the other --gate reuses that index.
// --gate legacy is the pre-#102 0.5-only ask() path (no weak band, no weak note).
// --temperature and --seed default to 0 and 42 in this script only. They are
// Ollama options on the eval ask() call. The app does not send them.
// The chat model is resolveChatModel(): the app preference list, unless --model is set.
// The first JSONL line is a summary record. Later lines are questions and include
// `gate`, `temperature`, `seed`, and `topChunks`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import {
  ask,
  indexVault,
  openIndex,
  UNCOVERED_ANSWER,
  coverageBand,
  DEFAULT_COVERAGE_FLOOR,
  DEFAULT_COVERAGE_THRESHOLD,
} from "../dist/index.js";

function usage() {
  return [
    "usage: node packages/engine/scripts/eval-classic-ask.mjs --vault <path> --questions <csv> --out <jsonl> [--model <tag>] [--gate current|legacy] [--temperature <n>] [--seed <n>]",
    "CSV header: id,bucket,question,gold_file",
    "--gate legacy refuses every cosine under 0.5 before the model. Default is current.",
    "--temperature defaults to 0 and --seed defaults to 42. App Ask does not send them.",
    "Indexing runs only when <vault>/.cairn/index.db is missing.",
  ].join("\n");
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (
      arg === "--vault" ||
      arg === "--questions" ||
      arg === "--out" ||
      arg === "--model" ||
      arg === "--gate" ||
      arg === "--temperature" ||
      arg === "--seed"
    ) {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} needs a value`);
      }
      flags[arg.slice(2)] = value;
      i++;
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return flags;
}

/** Minimal CSV: commas, quotes, and "" escapes. Newlines inside quotes are kept. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.length > 0)) rows.push(row);
  }
  return rows;
}

/** strong, weak, below (cosine under the floor), or lexical (NaN cosine). */
function askBand(result) {
  if (result.mode === "lexical") return "lexical";
  const named = coverageBand(
    {
      covered: Number.isFinite(result.poolMaxCosine) && result.poolMaxCosine >= DEFAULT_COVERAGE_THRESHOLD,
      poolMaxCosine: result.poolMaxCosine,
      threshold: DEFAULT_COVERAGE_THRESHOLD,
    },
    DEFAULT_COVERAGE_FLOOR,
  );
  return named === "refuse" ? "below" : named;
}

function extensionOf(file) {
  const ext = extname(file).toLowerCase();
  return ext || "(none)";
}

function finiteFlag(name, raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number`);
  return n;
}

/** Counts from the open index. Totals are the chunk table, which is what Ask searches. */
function indexSummary(index, gate, temperature, seed) {
  const files = index.listFiles();
  const chunkFiles = index.listChunkFiles();
  const byExt = new Map();
  const rowFor = (file) => {
    const ext = extensionOf(file);
    let row = byExt.get(ext);
    if (!row) {
      row = { ext, files: 0, chunks: 0 };
      byExt.set(ext, row);
    }
    return row;
  };
  for (const file of files) rowFor(file).files += 1;
  for (const file of chunkFiles) rowFor(file).chunks += 1;
  const extensions = [...byExt.values()].sort((a, b) => a.ext.localeCompare(b.ext));
  return {
    record: "summary",
    vault: index.vaultRoot,
    embedder: index.getMeta("embedder") ?? null,
    mode: index.getMeta("mode") ?? null,
    files: files.length,
    chunks: chunkFiles.length,
    extensions,
    gate,
    temperature,
    seed,
  };
}

function writeSummary(summary) {
  const extensions = summary.extensions
    .map((row) => `${row.ext} ${row.files} files/${row.chunks} chunks`)
    .join(", ");
  process.stderr.write(
    `index ${summary.vault} embedder=${summary.embedder ?? "none"} mode=${summary.mode ?? "unknown"} files=${summary.files} chunks=${summary.chunks} temperature=${summary.temperature} seed=${summary.seed}\n${extensions}\n`,
  );
}

function citedFiles(answer, sources) {
  const files = [];
  const seen = new Set();
  for (const match of String(answer).matchAll(/\[(\d+)\]/g)) {
    const n = Number(match[1]);
    if (!Number.isInteger(n) || n < 1) continue;
    const file = sources[n - 1]?.file;
    if (!file || seen.has(file)) continue;
    seen.add(file);
    files.push(file);
  }
  return files;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!flags.vault || !flags.questions || !flags.out) {
    throw new Error(usage());
  }
  const gate = flags.gate ?? "current";
  if (gate !== "current" && gate !== "legacy") {
    throw new Error("--gate must be current or legacy");
  }
  const temperature = flags.temperature === undefined ? 0 : finiteFlag("--temperature", flags.temperature);
  const seed = flags.seed === undefined ? 42 : finiteFlag("--seed", flags.seed);
  if (!Number.isInteger(seed)) throw new Error("--seed must be an integer");

  const vault = resolve(flags.vault);
  const questionsPath = resolve(flags.questions);
  const outPath = resolve(flags.out);
  if (!existsSync(join(vault, ".cairn", "index.db"))) {
    process.stderr.write(`indexing ${vault}\n`);
    await indexVault(vault);
  }

  const table = parseCsv(readFileSync(questionsPath, "utf8"));
  const header = table[0]?.map((cell) => cell.trim()) ?? [];
  if (header.join(",") !== "id,bucket,question,gold_file") {
    throw new Error("CSV header must be id,bucket,question,gold_file");
  }

  const index = openIndex(vault);
  const lines = [];
  try {
    const summary = indexSummary(index, gate, temperature, seed);
    writeSummary(summary);
    lines.push(JSON.stringify(summary));
    const askOpts = { gate, temperature, seed };
    if (flags.model) askOpts.model = flags.model;
    for (const cells of table.slice(1)) {
      const [id = "", bucket = "", question = "", goldFile = ""] = cells;
      const started = performance.now();
      const result = await ask(index, question, askOpts);
      const elapsedMs = Math.round(performance.now() - started);
      const refused = result.answer === UNCOVERED_ANSWER;
      lines.push(JSON.stringify({
        id,
        bucket,
        question,
        gold_file: goldFile,
        refused,
        answered: !refused,
        answer: result.answer,
        cited: citedFiles(result.answer, result.sources),
        model: result.model ?? null,
        poolMaxCosine: Number.isFinite(result.poolMaxCosine) ? result.poolMaxCosine : null,
        mode: result.mode,
        band: askBand(result),
        gate,
        temperature,
        seed,
        topChunks: result.topChunks,
        elapsed_ms: elapsedMs,
      }));
    }
  } finally {
    index.close();
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, lines.length > 0 ? `${lines.join("\n")}\n` : "");
  const questionRows = Math.max(0, lines.length - 1);
  const questionLabel = questionRows === 1 ? "question row" : "question rows";
  process.stderr.write(`wrote 1 summary and ${questionRows} ${questionLabel} to ${outPath}\n`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
