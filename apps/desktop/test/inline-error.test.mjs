// The inline chat error must show the Ollama sentence, not Electron's IPC wrapper.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const { inlineErrorText } = await import("../out-test/inline-error.js");

const OLLAMA_DOWN =
  "Local Ollama request failed. Check that Ollama is running and the required models are installed.";

const app = readFileSync(new URL("../src/renderer/App.tsx", import.meta.url), "utf8");

test("the chat:send IPC prefix is stripped from the inline Ollama-down error", () => {
  const wrapped = new Error(`Error invoking remote method 'chat:send': ${OLLAMA_DOWN}`);
  assert.equal(inlineErrorText(wrapped), OLLAMA_DOWN);
  assert.equal(inlineErrorText(OLLAMA_DOWN), OLLAMA_DOWN);
  assert.equal(inlineErrorText(new Error("Ask needs a question.")), "Ask needs a question.");
});

test("chat errors render the stripped message", () => {
  assert.match(app, /function errorMessage\(error: unknown\): string \{\n  return inlineErrorText\(error\);\n\}/);
  assert.match(app, /settleStreaming\(prev, \{ role: "error", text: message \}\)/);
});
