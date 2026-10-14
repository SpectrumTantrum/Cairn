// Agentic Ask model guidance (plan 1d). The copy is a pure function. React wiring is
// source-locked: Settings always prints the tested line, the composer warning sits
// above the composer, and Ask still sends while that warning is showing.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const {
  AGENTIC_TOOLS_WARNING,
  TESTED_AGENTIC_LINE,
  agenticGuidanceText,
  isTestedAgenticModel,
  resolveAskChatModel,
} = await import("../out-test/settings.js");

const app = readFileSync(new URL("../src/renderer/App.tsx", import.meta.url), "utf8");
const dialog = readFileSync(new URL("../src/renderer/components/shell/SettingsDialog.tsx", import.meta.url), "utf8");
const chatTab = readFileSync(new URL("../src/renderer/components/shell/ChatTab.tsx", import.meta.url), "utf8");
const composer = readFileSync(new URL("../src/renderer/components/shell/Composer.tsx", import.meta.url), "utf8");
const ipc = readFileSync(new URL("../src/main/ipc.ts", import.meta.url), "utf8");
const preload = readFileSync(new URL("../src/preload/index.ts", import.meta.url), "utf8");
const chat = readFileSync(new URL("../../../packages/engine/src/chat.ts", import.meta.url), "utf8");
const settings = readFileSync(new URL("../src/renderer/settings.ts", import.meta.url), "utf8");

const MODELS = ["qwen3-embedding:0.6b", "qwen3:4b", "qwen3:8b", "llama3.2:3b"];

function guidance(overrides) {
  return agenticGuidanceText({
    agentic: true,
    ollamaUp: true,
    model: "qwen3:8b",
    capability: "capable",
    ...overrides,
  });
}

test("the tested line is present in every state", () => {
  const states = [
    guidance({}),
    guidance({ model: "qwen3:4b", capability: "capable" }),
    guidance({ model: "llama3.2:3b", capability: "incapable" }),
    guidance({ capability: "unknown" }),
    guidance({ ollamaUp: false, capability: "incapable" }),
    guidance({ agentic: false, capability: "incapable", model: "llama3.2:3b" }),
    guidance({ model: null, capability: "capable" }),
  ];
  for (const state of states) {
    assert.match(state.settingsLine, /^Tested with qwen3:8b\./);
  }
});

test("a tool-capable tested model names itself and shows no warning", () => {
  const state = guidance({ model: "qwen3:8b", capability: "capable" });
  assert.equal(state.settingsLine, "Tested with qwen3:8b. Using qwen3:8b.");
  assert.equal(state.settingsWarning, null);
  assert.equal(state.composerWarning, null);
  const latest = guidance({ model: "qwen3:8b:latest", capability: "capable" });
  assert.equal(latest.settingsLine, "Tested with qwen3:8b. Using qwen3:8b:latest.");
  assert.equal(latest.composerWarning, null);
  assert.equal(isTestedAgenticModel("qwen3:8b:latest"), true);
  assert.equal(isTestedAgenticModel("qwen3:4b"), false);
});

test("qwen3:4b tool-capable agentic on is Settings text only", () => {
  const state = guidance({ model: "qwen3:4b", capability: "capable" });
  assert.equal(
    state.settingsLine,
    "Tested with qwen3:8b. Using qwen3:4b, which hasn't been tested with Agentic Ask.",
  );
  assert.equal(state.settingsWarning, null);
  assert.equal(state.composerWarning, null);
});

test("no tools capability warns in Settings and above the composer", () => {
  const state = guidance({ model: "llama3.2:3b", capability: "incapable" });
  assert.equal(state.settingsLine, TESTED_AGENTIC_LINE);
  assert.equal(state.settingsWarning, AGENTIC_TOOLS_WARNING);
  assert.equal(state.composerWarning, AGENTIC_TOOLS_WARNING);
  assert.equal(
    AGENTIC_TOOLS_WARNING,
    "This model can't use tools, so Agentic Ask won't work with it. Pick qwen3:8b or turn Agentic Ask off.",
  );
});

test("unknown, capable, or agentic off shows no warning", () => {
  for (const state of [
    guidance({ capability: "unknown" }),
    guidance({ model: "qwen3:8b", capability: "capable" }),
    guidance({ agentic: false, model: "llama3.2:3b", capability: "incapable" }),
  ]) {
    assert.equal(state.settingsWarning, null);
    assert.equal(state.composerWarning, null);
  }
  assert.equal(guidance({ capability: "unknown" }).settingsLine, TESTED_AGENTIC_LINE);
  assert.equal(
    guidance({ agentic: false, model: "qwen3:8b", capability: "capable" }).settingsLine,
    TESTED_AGENTIC_LINE,
  );
});

test("chip or toggle changes update the warning without an Ask", () => {
  const tested = guidance({ model: "qwen3:8b", capability: "capable" });
  const incapable = guidance({ model: "llama3.2:3b", capability: "incapable" });
  const off = guidance({ agentic: false, model: "llama3.2:3b", capability: "incapable" });
  assert.equal(tested.composerWarning, null);
  assert.equal(incapable.composerWarning, AGENTIC_TOOLS_WARNING);
  assert.equal(off.composerWarning, null);
  assert.equal(off.settingsLine, TESTED_AGENTIC_LINE);
  assert.match(app, /\[ollama\.up, ollama\.models, ollama\.recovered, selectedModel, agenticAskEnabled\]/);
  assert.match(app, /modelInfo\(model\)/);
  const ask = app.slice(app.indexOf("async function runAgenticAskChat"), app.indexOf("async function runChat"));
  assert.doesNotMatch(ask, /modelInfo|shownModelInfo|guidance/);
});

test("Ollama down shows no warning", () => {
  const state = guidance({ ollamaUp: false, model: "llama3.2:3b", capability: "incapable" });
  assert.equal(state.settingsLine, TESTED_AGENTIC_LINE);
  assert.equal(state.settingsWarning, null);
  assert.equal(state.composerWarning, null);
  assert.match(app, /if \(!ollama\.up\) \{\n\s+setShownModelInfo\(null\);/);
});

test("the resolved model is the chip, or resolveChatModel when the chip is an embedder", () => {
  assert.equal(resolveAskChatModel("qwen3:8b", MODELS), "qwen3:8b");
  assert.equal(resolveAskChatModel("qwen3:4b", MODELS), "qwen3:4b");
  assert.equal(resolveAskChatModel(null, MODELS), "qwen3:8b");
  assert.equal(resolveAskChatModel("qwen3-embedding:0.6b", MODELS), "qwen3:8b");
  assert.equal(resolveAskChatModel(null, ["gemma4:e4b", "qwen3:4b", "llama3.2:3b"]), "qwen3:4b");
  assert.equal(resolveAskChatModel(null, ["nomic-embed-text", "llama3.2:3b"]), "llama3.2:3b");
  const prefer = chat.match(/const CHAT_MODEL_PREFER = (\[[^\]]+\])/);
  const desktop = settings.match(/CHAT_MODEL_PREFER = (\[[^\]]+\])/);
  assert.ok(prefer && desktop);
  assert.equal(desktop[1], prefer[1]);
});

test("Settings renders the tested line and a shortened field note", () => {
  assert.match(dialog, /<p className="field-note">\{guidanceLine\}<\/p>/);
  assert.match(dialog, /guidanceWarning \? <p className="field-note warn">\{guidanceWarning\}<\/p> : null/);
  assert.match(dialog, /CAIRN_AGENTIC_ASK=1/);
  assert.match(dialog, /bounded read-only tool loop/);
  assert.doesNotMatch(dialog, /qwen3:4b/);
  assert.doesNotMatch(dialog, /time out/);
});

test("the warning is above the composer and Ask still sends", () => {
  const warningAt = chatTab.indexOf('className="composer-model-warning"');
  const composerAt = chatTab.indexOf("<Composer");
  assert.ok(warningAt !== -1 && composerAt !== -1 && warningAt < composerAt);
  assert.match(composer, /disabled=\{!canSend\}/);
  assert.doesNotMatch(composer, /composerWarning|guidanceWarning|modelInfo/);
  const ask = app.slice(app.indexOf("async function runAgenticAskChat"), app.indexOf("async function runChat"));
  assert.match(ask, /askAgentVault\(question/);
  assert.match(ask, /model: selectedModel \?\? undefined/);
  assert.match(app, /composerWarning=\{guidance\.composerWarning\}/);
  assert.match(app, /guidanceLine=\{guidance\.settingsLine\}/);
  assert.match(app, /guidanceWarning=\{guidance\.settingsWarning\}/);
});

test("ollama:modelInfo is the IPC and the warm probe clears the show cache", () => {
  assert.match(ipc, /ipcMain\.handle\("ollama:modelInfo"/);
  assert.match(ipc, /return await provider\.modelInfo\(model\)/);
  assert.match(ipc, /return "unknown"/);
  assert.match(ipc, /if \(provider\.probeForWarm\) return await provider\.probeForWarm\(\)/);
  assert.match(preload, /modelInfo: \(model\) => ipcRenderer\.invoke\("ollama:modelInfo", model\)/);
  const provider = readFileSync(new URL("../../../packages/engine/src/model-provider.ts", import.meta.url), "utf8");
  const probe = provider.slice(provider.indexOf("async probeForWarm"), provider.indexOf("private async primeAndEmbed"));
  assert.match(probe, /noteOllamaReachability\(false\)/);
  assert.match(probe, /noteOllamaReachability\(true\)/);
  assert.match(probe, /if \(invalidated\) this\.clearShowCapability\(\)/);
  assert.equal(app.match(/setInterval\(/g)?.length, 1);
});
