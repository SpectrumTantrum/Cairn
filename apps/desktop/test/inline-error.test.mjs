// Electron serializes a thrown Error with toString(), so the renderer message is
// `Error invoking remote method '<channel>': Error: <sentence>`. The inline chat
// error must show only the Ollama sentence, in classic and agentic Ask.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const { inlineErrorText } = await import("../out-test/inline-error.js");

const OLLAMA_DOWN =
  "Local Ollama request failed. Check that Ollama is running and the required models are installed.";

const app = readFileSync(new URL("../src/renderer/App.tsx", import.meta.url), "utf8");

/** The message string Electron puts on the renderer Error for a rejected invoke. */
function electronInvokeMessage(channel, sentence, errorName = "Error") {
  return `Error invoking remote method '${channel}': ${errorName}: ${sentence}`;
}

function slice(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from !== -1 && to !== -1, `missing slice ${start}`);
  return source.slice(from, to);
}

test("the serialized Error prefix is stripped from the real Electron invoke message", () => {
  assert.equal(
    inlineErrorText(new Error(electronInvokeMessage("chat:send", OLLAMA_DOWN))),
    OLLAMA_DOWN,
  );
  assert.equal(
    inlineErrorText(new Error(electronInvokeMessage("vault:askAgent", OLLAMA_DOWN))),
    OLLAMA_DOWN,
  );
  assert.equal(
    inlineErrorText(new Error(electronInvokeMessage("chat:send", OLLAMA_DOWN, "TypeError"))),
    OLLAMA_DOWN,
  );
  assert.equal(inlineErrorText(OLLAMA_DOWN), OLLAMA_DOWN);
  assert.equal(inlineErrorText(new Error("Ask needs a question.")), "Ask needs a question.");
});

test("classic and agentic Ask render the stripped message", () => {
  assert.match(app, /function errorMessage\(error: unknown\): string \{\n  return inlineErrorText\(error\);\n\}/);
  const agentic = slice(app, "async function runAgenticAskChat", "async function runChat");
  const classic = slice(app, "async function runChat", "function onSubmit");
  for (const body of [agentic, classic]) {
    assert.match(body, /const message = errorMessage\(err\)/);
    assert.match(body, /settleStreaming\(prev, \{ role: "error", text: message \}\)/);
  }
});
