// Classification of main-process errors shown in the renderer. ABI mismatches
// mention better-sqlite3 / sqlite in the dlopen text; they must not be told to
// re-index.

import assert from "node:assert/strict";
import { test } from "node:test";

const { toUserError, NATIVE_MODULE_MISMATCH_MESSAGE, INDEX_READ_MESSAGE } = await import(
  "../out-test/user-error.js"
);

const ABI_MESSAGE = [
  "The module '/workspace/packages/engine/node_modules/better-sqlite3/build/Release/better_sqlite3.node'",
  "was compiled against a different Node.js version using",
  "NODE_MODULE_VERSION 127. This version of Node.js requires",
  "NODE_MODULE_VERSION 146. Please try re-compiling or re-installing",
  "the module (for instance, using `npm rebuild` or `npm install`).",
].join("\n");

test("NODE_MODULE_VERSION mismatch is a native-module error, not a re-index hint", () => {
  const error = new Error(ABI_MESSAGE);
  error.code = "ERR_DLOPEN_FAILED";
  const message = toUserError(error).message;
  assert.equal(message, NATIVE_MODULE_MISMATCH_MESSAGE);
  assert.equal(message.includes("re-index"), false);
});

test("ERR_DLOPEN_FAILED is a native-module error even without the version text", () => {
  const error = new Error("dlopen(better_sqlite3.node) failed");
  error.code = "ERR_DLOPEN_FAILED";
  assert.equal(toUserError(error).message, NATIVE_MODULE_MISMATCH_MESSAGE);
});

test("a wrapped dlopen cause is still a native-module error", () => {
  const cause = new Error("The module better_sqlite3.node did not self-register.");
  cause.code = "ERR_DLOPEN_FAILED";
  const error = new Error("Could not open the vault index");
  error.cause = cause;
  assert.equal(toUserError(error).message, NATIVE_MODULE_MISMATCH_MESSAGE);
});

test("invalid ELF header is a native-module error", () => {
  const error = new Error(
    "/workspace/node_modules/better-sqlite3/build/Release/better_sqlite3.node: invalid ELF header",
  );
  assert.equal(toUserError(error).message, NATIVE_MODULE_MISMATCH_MESSAGE);
});

test("a corrupt index still asks the user to re-index", () => {
  const error = new Error("SqliteError: database disk image is malformed");
  assert.equal(toUserError(error).message, INDEX_READ_MESSAGE);
});

test("a missing vec table still asks the user to re-index", () => {
  const error = new Error("SQLITE_ERROR: no such table: vec_chunks");
  assert.equal(toUserError(error).message, INDEX_READ_MESSAGE);
});

test("Ollama transport failures keep the Ollama message", () => {
  const error = new Error("fetch failed: connect ECONNREFUSED 127.0.0.1:11434");
  assert.equal(
    toUserError(error).message,
    "Local Ollama request failed. Check that Ollama is running and the required models are installed.",
  );
});

test("allow-listed vault errors pass through", () => {
  const error = new Error("The source file is no longer available. Try re-indexing this vault.");
  assert.equal(toUserError(error).message, error.message);
});

test("unknown errors are truncated", () => {
  const error = new Error("x".repeat(400));
  const message = toUserError(error).message;
  assert.equal(message.length, 220);
  assert.equal(message.endsWith("..."), true);
});

test("undici HeadersTimeoutError cause maps to an explicit Ollama timeout message", () => {
  const cause = new Error("Headers Timeout Error");
  cause.name = "HeadersTimeoutError";
  cause.code = "UND_ERR_HEADERS_TIMEOUT";
  const error = new Error("fetch failed");
  error.cause = cause;
  const message = toUserError(error).message;
  assert.match(message, /timed out/i);
  assert.equal(message.includes("re-index"), false);
});

test("OllamaTimeoutError text passes through verbatim", () => {
  const error = new Error(
    "Local Ollama request timed out after 600s (chat-with-tools). The model may be too slow under load for this path — retry when the machine is quieter, use a faster model, or turn off agentic Ask.",
  );
  assert.equal(toUserError(error).message, error.message);
});
