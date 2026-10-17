// Stop during Ask uses the same Ollama cancel as New chat, then removes only the
// streaming draft. Esc in the Ask box triggers that action. The React tree has no
// node harness, so this locks the wiring in source.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const composer = readFileSync(new URL("../src/renderer/components/shell/Composer.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/renderer/App.tsx", import.meta.url), "utf8");

function slice(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from !== -1 && to !== -1, `missing slice ${start}`);
  return source.slice(from, to);
}

test("the Ask box shows Stop while a turn is in flight and Esc triggers it", () => {
  const fn = slice(composer, "export function Composer", "function ModeChip");
  assert.match(fn, /const showStop = busy && mode === "ask" && canStop/);
  assert.match(fn, /e\.key === "Escape" && showStop/);
  assert.match(fn, /onStop\(\)/);
  assert.match(fn, /aria-label="Stop"/);
  assert.match(fn, /title="Stop \(Esc\)"/);
  assert.match(fn, /className="send-btn stop-btn"/);
  assert.match(fn, /<ModeChip mode=\{mode\} busy=\{busy\}/);
  const modeChip = slice(composer, "function ModeChip", "function EscalateChip");
  assert.match(modeChip, /disabled=\{busy\}/);
  assert.match(modeChip, /if \(busy\) setOpen\(false\)/);
});

test("Stop aborts the in-flight Ask and removes only the streaming draft", () => {
  const stop = slice(app, "function stopAsk()", "function newThread()");
  assert.match(stop, /if \(!canStop\) return/);
  assert.match(stop, /activeRequestId\.current = -1/);
  assert.match(stop, /window\.cairn\.stopAsk\(\)/);
  assert.match(stop, /setAsking\(false\)/);
  assert.match(stop, /setCanStop\(false\)/);
  const classic = slice(app, "async function runChat", "function onSubmit()");
  const agentic = slice(app, "async function runAgenticAskChat", "async function runChat");
  const studio = slice(app, "async function submitStudio", "const patchProposal");
  const agent = slice(app, "async function submitAgent", "async function submitStudio");
  assert.match(classic, /setCanStop\(true\)/);
  assert.match(agentic, /setCanStop\(true\)/);
  assert.match(studio, /setCanStop\(false\)/);
  assert.equal(studio.includes("setCanStop(true)"), false);
  assert.match(agent, /setCanStop\(false\)/);
  assert.equal(agent.includes("setCanStop(true)"), false);
  const load = slice(app, "const loadThread", "const deleteThread");
  const choose = slice(app, "async function adoptVault", "const toggleFolder");
  assert.match(load, /setCanStop\(false\)/);
  assert.match(choose, /setCanStop\(false\)/);
  assert.match(stop, /last\?\.role === "assistant" && last\.streaming/);
  assert.match(stop, /prev\.slice\(0, -1\)/);
  assert.equal(stop.includes("resetChat"), false);
  assert.equal(stop.includes("setThread([])"), false);

  const fresh = slice(app, "function newThread()", "async function runSearch()");
  assert.match(fresh, /window\.cairn\.resetChat\(\)/);
  assert.match(fresh, /setThread\(\[\]\)/);
});
