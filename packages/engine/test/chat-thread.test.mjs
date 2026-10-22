import assert from "node:assert/strict";
import { after, before, test } from "node:test";

let ChatThread;
let ask;
let setModelProvider;
let resetModelProvider;
let FakeModelProvider;
let InMemoryIndex;
let UNCOVERED_ANSWER;
let WEAK_MATCH_NOTE;

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
  UNCOVERED_ANSWER = engine.UNCOVERED_ANSWER;
  WEAK_MATCH_NOTE = engine.WEAK_MATCH_NOTE;
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

test("aborting a classic turn drops it from history and the next turn still answers", async () => {
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const enteredGate = new Promise((resolve) => {
    entered = resolve;
  });
  let n = 0;
  const seen = [];
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatStream: async (_model, messages, callbacks) => {
        n += 1;
        seen.push(messages.map((m) => m.content).join("\n"));
        if (n === 2) {
          entered();
          await gate;
          if (callbacks?.signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
          }
          return "should not finish";
        }
        return "Grounded answer [1].";
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const thread = new ChatThread(index, { mode: "lexical" });
    const first = await thread.send("What is a vault?", { onToken() {} });
    assert.equal(first.answer, "Grounded answer [1].");
    const ac = new AbortController();
    const pending = thread.send("CANCEL ME vault", { onToken() {}, signal: ac.signal });
    await enteredGate;
    ac.abort();
    release();
    await assert.rejects(pending, (err) => err instanceof DOMException && err.name === "AbortError");
    assert.equal(thread.messages.length, 2);
    assert.equal(thread.messages[1].content, "Grounded answer [1].");
    const next = await thread.send("What is cache invalidation?", { onToken() {} });
    assert.equal(next.answer, "Grounded answer [1].");
    assert.equal(seen[2].includes("CANCEL ME"), false);
    assert.match(seen[2], /What is a vault/);
    assert.match(seen[2], /cache invalidation/);
  } finally {
    release();
    index.close();
  }
});

test("a newer send does not keep the cancelled question in history", async () => {
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const enteredGate = new Promise((resolve) => {
    entered = resolve;
  });
  const seen = [];
  let calls = 0;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatStream: async (_model, messages, callbacks) => {
        calls += 1;
        seen.push(messages.map((m) => m.content).join("\n"));
        if (calls === 1) {
          entered();
          await gate;
          if (callbacks?.signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
          }
          return "late first answer [1].";
        }
        return "A cache is a fast store [1].";
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const thread = new ChatThread(index, { mode: "lexical" });
    const firstSignal = new AbortController();
    const pending = thread.send("CANCEL ME vault", {
      onToken() {},
      signal: firstSignal.signal,
    });
    await enteredGate;
    firstSignal.abort();
    const next = thread.send("What is cache invalidation?", {
      signal: new AbortController().signal,
    });
    release();
    await assert.rejects(pending, (err) => err instanceof DOMException && err.name === "AbortError");
    const result = await next;
    assert.equal(result.answer, "A cache is a fast store [1].");
    assert.equal(seen.at(-1).includes("CANCEL ME"), false);
    assert.equal(
      thread.messages.some((m) => m.content.includes("CANCEL ME")),
      false,
    );
    assert.equal(thread.messages[0].content, "What is cache invalidation?");
  } finally {
    release();
    index.close();
  }
});

test("signal without onToken still cancels the model call", async () => {
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const enteredGate = new Promise((resolve) => {
    entered = resolve;
  });
  let streamed = false;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chat: async () => "recorded anyway [1].",
      chatStream: async (_model, _messages, callbacks) => {
        streamed = true;
        entered();
        await gate;
        if (callbacks?.signal?.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        return "recorded anyway [1].";
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const thread = new ChatThread(index, { mode: "lexical" });
    const ac = new AbortController();
    const pending = thread.send("What is a vault?", { signal: ac.signal });
    await enteredGate;
    ac.abort();
    release();
    await assert.rejects(pending, (err) => err instanceof DOMException && err.name === "AbortError");
    assert.equal(streamed, true);
    assert.equal(thread.messages.length, 0);
  } finally {
    release();
    index.close();
  }
});

function vec(values) {
  return Buffer.from(Float32Array.from(values).buffer);
}

function cosineVec(cosine) {
  const y = Math.sqrt(Math.max(0, 1 - cosine * cosine));
  return vec([cosine, y, 0, 0]);
}

function hybridIndex(cosine) {
  const index = new InMemoryIndex();
  index.rebuildIndex({
    mode: "hybrid",
    embedder: "test-embedder",
    dim: 4,
    files: 1,
    chunks: [
      {
        id: 1,
        file: "finch.md",
        ordinal: 0,
        line: 1,
        heading: "Copper finch",
        text: "The copper finch lives in the margin of the ledger.",
        hash: "h1",
        vector: cosineVec(cosine),
      },
    ],
  });
  return index;
}

const FINCH_QUESTION = "Where does the copper finch live?";

test("ChatThread keeps a strong answer and does not add the weak-match note", async () => {
  const seen = [];
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b", "test-embedder"],
      chat: (_model, messages) => {
        seen.push(messages);
        return Promise.resolve("It lives in the margin.");
      },
    }),
  );
  const index = hybridIndex(0.9);
  try {
    const thread = new ChatThread(index, { mode: "hybrid" });
    const result = await thread.send(FINCH_QUESTION);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].at(-1).content.includes(WEAK_MATCH_NOTE), false);
    assert.equal(result.answer, "It lives in the margin.");
    assert.equal(result.covered, true);
    assert.equal(thread.messages.at(-1).content, "It lives in the margin.");
  } finally {
    index.close();
  }
});

test("ChatThread calls the model in the weak band and keeps an answer that cites [n]", async () => {
  const seen = [];
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b", "test-embedder"],
      chat: (_model, messages) => {
        seen.push(messages);
        return Promise.resolve("It lives in the margin of the ledger [1].");
      },
    }),
  );
  const index = hybridIndex(0.35);
  try {
    const thread = new ChatThread(index, { mode: "hybrid" });
    const tokens = [];
    const result = await thread.send(FINCH_QUESTION, { onToken: (t) => tokens.push(t) });
    const user = seen[0].at(-1).content;
    assert.ok(user.indexOf("QUESTION:") < user.indexOf(WEAK_MATCH_NOTE));
    assert.equal(result.answer, "It lives in the margin of the ledger [1].");
    assert.equal(tokens.join(""), result.answer);
    assert.equal(result.covered, true);
    assert.equal(result.sources[0].file, "finch.md");
    assert.equal(thread.messages.at(-1).content, result.answer);
  } finally {
    index.close();
  }
});

test("ChatThread suppresses a weak-band answer that has no [n] citation", async () => {
  let calls = 0;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b", "test-embedder"],
      chat: () => {
        calls += 1;
        return Promise.resolve("It lives in the margin of the ledger.");
      },
    }),
  );
  const index = hybridIndex(0.35);
  try {
    const thread = new ChatThread(index, { mode: "hybrid" });
    const tokens = [];
    const result = await thread.send(FINCH_QUESTION, { onToken: (t) => tokens.push(t) });
    assert.equal(calls, 1);
    assert.equal(result.answer, UNCOVERED_ANSWER);
    assert.equal(result.covered, false);
    assert.equal(result.grounded, false);
    assert.deepEqual(result.sources, []);
    assert.deepEqual(tokens, []);
    assert.equal(thread.messages.at(-1).content, UNCOVERED_ANSWER);
    assert.equal(thread.messages.at(-1).content.includes("margin"), false);
  } finally {
    index.close();
  }
});

test("ChatThread refuses below the coverage floor without calling the model", async () => {
  let calls = 0;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b", "test-embedder"],
      chat: () => {
        calls += 1;
        return Promise.resolve("should not be called [1]");
      },
    }),
  );
  const index = hybridIndex(0.1);
  try {
    const thread = new ChatThread(index, { mode: "hybrid" });
    const result = await thread.send(FINCH_QUESTION);
    assert.equal(calls, 0);
    assert.equal(result.answer, UNCOVERED_ANSWER);
    assert.equal(result.covered, false);
    assert.match(result.reason, /coverage threshold/i);
    assert.deepEqual(result.sources, []);
  } finally {
    index.close();
  }
});

test("ChatThread leaves lexical mode unchanged, including an answer with no [n]", async () => {
  const seen = [];
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b", "test-embedder"],
      chat: (_model, messages) => {
        seen.push(messages);
        return Promise.resolve("A vault is a folder of notes.");
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const thread = new ChatThread(index, { mode: "lexical" });
    const result = await thread.send("What is cache invalidation?");
    assert.equal(seen[0].at(-1).content.includes(WEAK_MATCH_NOTE), false);
    assert.equal(result.answer, "A vault is a folder of notes.");
    assert.equal(result.covered, true);
    assert.equal(result.mode, "lexical");
  } finally {
    index.close();
  }
});
