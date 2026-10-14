// Chat-model warm-up is background-only. The React tree has no node harness, so
// this locks the launch, model-change, and agentic-on triggers, and the silent IPC.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const app = readFileSync(new URL("../src/renderer/App.tsx", import.meta.url), "utf8");
const ipc = readFileSync(new URL("../src/main/ipc.ts", import.meta.url), "utf8");
const preload = readFileSync(new URL("../src/preload/index.ts", import.meta.url), "utf8");

function slice(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from !== -1 && to !== -1, `missing slice ${start}`);
  return source.slice(from, to);
}

test("warm-up fires after launch check, on model change, and when agentic Ask is turned on", () => {
  const refresh = slice(app, "async function refreshOllama()", "function selectChatModel");
  assert.match(refresh, /window\.cairn\.checkOllama\(\)/);
  assert.match(refresh, /if \(status\.up\) requestChatWarm\(model\)/);
  const select = slice(app, "function selectChatModel", "const refreshProviders");
  assert.match(select, /requestChatWarm\(model\)/);
  assert.match(app, /onSelectModel=\{selectChatModel\}/);
  const toggle = slice(app, "onAgenticAskChange={(enabled)", "onResetLayout");
  assert.match(toggle, /if \(enabled\) requestChatWarm\(selectedModel\)/);
  const request = slice(app, "function requestChatWarm", "async function refreshOllama");
  assert.match(request, /warmChatModel\(model\)\.catch\(\(\) => \{\}\)/);
  assert.equal(request.includes("setError"), false);
  assert.equal(request.includes("setAsking"), false);
});

test("ollama:warm never rejects and the preload exposes it", () => {
  const warmStart = ipc.indexOf('ipcMain.handle("ollama:warm"');
  assert.ok(warmStart !== -1);
  const warm = ipc.slice(warmStart);
  assert.match(warm, /return "skipped"/);
  assert.match(warm, /return "failed"/);
  assert.match(warm, /provider\.warmChatModel\(model\)/);
  assert.match(preload, /warmChatModel: \(model\) => ipcRenderer\.invoke\("ollama:warm", model\)/);
});
