import assert from "node:assert/strict";
import { after, before, test } from "node:test";

let ChatThread;
let ask;
let setModelProvider;
let resetModelProvider;
let FakeModelProvider;
let InMemoryIndex;

// Lexical-only index (no vectors) so retrieval runs without embedding.
function seed(index) {
  index.rebuildIndex({
    mode: "lexical",
    files: 2,
    chunks: [
      { id: 1, file: "cache.md", ordinal: 0, line: 1, heading: "Caching", text: "Cache invalidation is naming things and expiry.", hash: "h1" },
      { id: 2, file: "vault.md", ordinal: 0, line: 1, heading: "Vaults", text: "A vault is a folder of Markdown notes.", hash: "h2" },
    ],
  });
}

before(async () => {
  const engine = await import("../dist/index.js");
  const testing = await import("../dist/testing.js");
  ChatThread = engine.ChatThread;
  ask = engine.ask;
  setModelProvider = engine.setModelProvider;
  resetModelProvider = engine.resetModelProvider;
  FakeModelProvider = testing.FakeModelProvider;
  InMemoryIndex = testing.InMemoryIndex;
});

after(() => {
  resetModelProvider();
});

test("ChatThread carries multi-turn history and returns grounded/cited metadata", async () => {
  const seen = [];
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b", "test-embedder"],
      chat: (model, messages) => {
        seen.push({ model, messages });
        return Promise.resolve("Grounded answer with a citation [1].");
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const thread = new ChatThread(index, { mode: "lexical" });

    const r1 = await thread.send("What is cache invalidation?");
    assert.equal(r1.grounded, true);
    assert.equal(r1.covered, true);
    assert.ok(r1.sources.length > 0);
    assert.match(r1.answer, /\[1\]/);

    const r2 = await thread.send("What is a vault?");
    assert.equal(r2.grounded, true);

    // The second model call must include the first turn's user+assistant messages
    // (the SYSTEM prompt + prior history + the fresh SOURCES/QUESTION turn).
    const secondCall = seen[1].messages;
    const roles = secondCall.map((m) => m.role);
    assert.equal(roles[0], "system");
    assert.ok(secondCall.some((m) => m.role === "user" && m.content.includes("What is cache invalidation?")));
    assert.ok(secondCall.some((m) => m.role === "assistant" && m.content.includes("Grounded answer")));

    // Thread records both turns of both exchanges, in order.
    assert.deepEqual(
      thread.messages.map((m) => m.role),
      ["user", "assistant", "user", "assistant"],
    );
  } finally {
    index.close();
  }
});

test("ChatThread refuses when retrieval does not cover the question", async () => {
  setModelProvider(new FakeModelProvider({ models: ["qwen3:4b"] }));
  const index = new InMemoryIndex();
  try {
    seed(index);
    const thread = new ChatThread(index, { mode: "lexical" });
    const r = await thread.send("photosynthesis chloroplast membranes");
    assert.equal(r.covered, false);
    assert.equal(r.grounded, false);
    assert.match(r.answer, /don't cover/i);
  } finally {
    index.close();
  }
});

test("ChatThread.send streams tokens through onToken and concatenates to the full answer", async () => {
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chat: () => Promise.resolve("Streamed grounded answer [1]."),
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const thread = new ChatThread(index, { mode: "lexical" });
    const tokens = [];
    const r = await thread.send("What is cache invalidation?", { onToken: (t) => tokens.push(t) });
    assert.ok(tokens.length > 1, "expected more than one streamed token");
    assert.equal(tokens.join(""), r.answer);
  } finally {
    index.close();
  }
});

test("per-call model override is threaded through ChatThread.send and ask()", async () => {
  const seen = [];
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b", "llama3.2:3b", "test-embedder"],
      chat: (model) => {
        seen.push(model);
        return Promise.resolve("Answer [1].");
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);

    // Default (no model) resolves to the preferred qwen3.
    const thread = new ChatThread(index, { mode: "lexical" });
    const def = await thread.send("What is cache invalidation?");
    assert.equal(def.model, "qwen3:4b");
    assert.equal(seen.at(-1), "qwen3:4b");

    // Per-send override picks any available model.
    const override = await thread.send("What is a vault?", { model: "llama3.2:3b" });
    assert.equal(override.model, "llama3.2:3b");
    assert.equal(seen.at(-1), "llama3.2:3b");

    // ask() honors the same per-call override.
    const asked = await ask(index, "What is a vault?", { mode: "lexical", model: "llama3.2:3b" });
    assert.equal(asked.model, "llama3.2:3b");
    assert.equal(seen.at(-1), "llama3.2:3b");
  } finally {
    index.close();
  }
});

test("escalation routes the turn to the passed provider, surfaces usage + sent, and skips local model validation", async () => {
  const localChatCalls = [];
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"], // NOTE: the cloud model below is deliberately NOT in this list
      chat: (m) => {
        localChatCalls.push(m);
        return Promise.resolve("LOCAL");
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const cloudCalls = [];
    const cloud = {
      async listModels() {
        return [];
      },
      async isReachable() {
        return true;
      },
      async embed() {
        throw new Error("Cloud providers are not used for embeddings — retrieval stays local.");
      },
      async chat() {
        cloudCalls.push("chat");
        return "CLOUD";
      },
      async chatStream(_model, _messages, callbacks) {
        cloudCalls.push("stream");
        callbacks?.onToken?.("CLO");
        callbacks?.onToken?.("UD");
        callbacks?.onUsage?.({ promptTokens: 5, completionTokens: 2, totalTokens: 7, costUsd: 0.0001 });
        return "CLOUD";
      },
    };

    const thread = new ChatThread(index, { mode: "lexical" });
    const tokens = [];
    const r = await thread.send("What is cache invalidation?", {
      provider: cloud,
      model: "gpt-4o-mini", // a cloud model id, never validated against the local pull list
      onToken: (t) => tokens.push(t),
    });

    assert.equal(r.escalated, true);
    assert.equal(r.model, "gpt-4o-mini");
    assert.equal(r.answer, "CLOUD");
    assert.equal(tokens.join(""), "CLOUD");
    assert.equal(r.usage.totalTokens, 7);
    assert.equal(r.usage.costUsd, 0.0001);
    assert.ok(r.sent.system.length > 0);
    assert.ok(r.sent.sourcesBlock.toLowerCase().includes("cache"));
    assert.equal(cloudCalls.length, 1);
    assert.equal(cloudCalls[0], "stream");
    assert.equal(localChatCalls.length, 0); // the local model was never asked to generate
  } finally {
    index.close();
  }
});

test("a local (non-escalated) turn never touches a cloud provider and reports no usage/sent", async () => {
  setModelProvider(new FakeModelProvider({ models: ["qwen3:4b"], chat: () => Promise.resolve("LOCAL [1].") }));
  const index = new InMemoryIndex();
  try {
    seed(index);
    const thread = new ChatThread(index, { mode: "lexical" });
    const r = await thread.send("What is a vault?");
    assert.notEqual(r.escalated, true);
    assert.equal(r.usage, undefined);
    assert.equal(r.sent, undefined);
  } finally {
    index.close();
  }
});

test("thread-level model default applies, and unavailable model rejects", async () => {
  setModelProvider(new FakeModelProvider({ models: ["qwen3:4b", "llama3.2:3b"] }));
  const index = new InMemoryIndex();
  try {
    seed(index);
    const thread = new ChatThread(index, { mode: "lexical", model: "llama3.2:3b" });
    const r = await thread.send("What is cache invalidation?");
    assert.equal(r.model, "llama3.2:3b");

    const bad = new ChatThread(index, { mode: "lexical", model: "not-pulled:70b" });
    await assert.rejects(() => bad.send("What is a vault?"), /not pulled/i);
  } finally {
    index.close();
  }
});
