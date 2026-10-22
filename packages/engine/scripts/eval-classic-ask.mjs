#!/usr/bin/env node
// Headless classic Ask eval. One JSONL row per question.
//
//   node packages/engine/scripts/eval-classic-ask.mjs \
//     --vault /path/to/vault \
//     --questions /path/to/questions.csv \
//     --out /tmp/cairn-eval.jsonl \
//     [--model <tag>]
//
// CSV header: id,bucket,question,gold_file
// Indexes the vault (hybrid) when <vault>/.cairn/index.db is missing.
// The chat model is resolveChatModel(): the app preference list, unless --model is set.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ask, indexVault, openIndex, UNCOVERED_ANSWER } from "../dist/index.js";

function usage() {
  return [
    "usage: node packages/engine/scripts/eval-classic-ask.mjs --vault <path> --questions <csv> --out <jsonl> [--model <tag>]",
    "CSV header: id,bucket,question,gold_file",
  ].join("\n");
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--vault" || arg === "--questions" || arg === "--out" || arg === "--model") {
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
    for (const cells of table.slice(1)) {
      const [id = "", bucket = "", question = "", goldFile = ""] = cells;
      const started = performance.now();
      const result = await ask(index, question, flags.model ? { model: flags.model } : {});
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
        elapsed_ms: elapsedMs,
      }));
    }
  } finally {
    index.close();
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, lines.length > 0 ? `${lines.join("\n")}\n` : "");
  process.stderr.write(`wrote ${lines.length} rows to ${outPath}\n`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
