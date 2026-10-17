// Chat-model warm-up is background-only. The React tree has no node harness, so
// this locks which model a fresh profile warms, the Ollama restart rewarm, and
// the silent IPC. The prompt body itself is locked in the engine suite.

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

test("a fresh profile warms resolveChatModel for both modes, not the first tag", () => {
  assert.equal(app.includes("models[0]"), false);
  const warm = slice(app, "function warmChatForAsk", "async function refreshOllama");
  assert.match(warm, /window\.cairn\.resolveChatModel\(agentic\)/);
  assert.match(warm, /if \(modelPinnedRef\.current\)/);
  assert.match(warm, /requestChatWarm\(target, agentic\)/);
  assert.match(warm, /setSelectedModel\(target\)/);
  const follow = slice(app, "Warm only after we know", "useEffect(() => {\n    writeRightTab");
  assert.match(follow, /if \(!featuresReady \|\| !ollama\.up\) return/);
  assert.match(follow, /warmChatForAsk\(agenticAskEnabled\)/);
  assert.match(follow, /\[featuresReady, agenticAskEnabled, ollama\.up, ollama\.recovered\]/);
  const select = slice(app, "function selectChatModel", "const refreshProviders");
  assert.match(select, /modelPinnedRef\.current = true/);
  assert.match(select, /requestChatWarm\(model, agenticRef\.current\)/);
  assert.match(app, /onSelectModel=\{selectChatModel\}/);
  const request = slice(app, "function requestChatWarm", "function warmChatForAsk");
  assert.match(request, /warmChatModel\(model, agentic\)\.catch\(\(\) => \{\}\)/);
  assert.equal(request.includes("setError"), false);
  assert.equal(request.includes("setAsking"), false);
});

test("Ollama coming back rewarms, and a steady up check does not", () => {
  const boot = slice(app, "void refreshOllama();", "return () => clearInterval(poll);");
  assert.match(boot, /setInterval\(\(\) => void refreshOllama\(\), OLLAMA_STATUS_POLL_MS\)/);
  const refresh = slice(app, "async function refreshOllama()", "function selectChatModel");
  assert.match(refresh, /window\.cairn\.checkOllama\(\)/);
  assert.match(refresh, /ollamaUpRef\.current = status\.up/);
  assert.match(refresh, /current\.recovered === status\.recovered/);
  assert.equal(refresh.includes("requestChatWarm"), false);
  const checkStart = ipc.indexOf('ipcMain.handle("ollama:check"');
  assert.ok(checkStart !== -1);
  const check = ipc.slice(checkStart, ipc.indexOf('ipcMain.handle("ollama:resolveChatModel"'));
  assert.match(check, /provider\.probeForWarm/);
  assert.match(check, /return await provider\.probeForWarm\(\)/);
  assert.match(check, /recovered: false/);
  assert.equal(check.includes("ollamaWasUp"), false);
  const resolve = ipc.slice(ipc.indexOf('ipcMain.handle("ollama:resolveChatModel"'));
  assert.match(resolve, /resolveChatModel\(undefined, \{ agentic: agentic === true \}\)/);
  assert.match(resolve, /return null/);
  assert.match(preload, /resolveChatModel: \(agentic\) => ipcRenderer\.invoke\("ollama:resolveChatModel", agentic\)/);
});

test("ollama:warm never rejects and primes the mode's real prompt", () => {
  const warmStart = ipc.indexOf('ipcMain.handle("ollama:warm"');
  assert.ok(warmStart !== -1);
  const warm = ipc.slice(warmStart);
  assert.match(warm, /return "skipped"/);
  assert.match(warm, /return "failed"/);
  assert.match(warm, /chatWarmRequest\(agentic === true \? "agentic" : "classic"\)/);
  assert.match(warm, /provider\.warmChatModel\(model, request\)/);
  assert.match(preload, /warmChatModel: \(model, agentic\) => ipcRenderer\.invoke\("ollama:warm", model, agentic\)/);
});
