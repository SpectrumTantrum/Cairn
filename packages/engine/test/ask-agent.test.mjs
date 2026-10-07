import assert from "node:assert/strict";
import { after, before, test } from "node:test";

let runAskAgent;
let runAskSearchTool;
let runAgent;
let setModelProvider;
let resetModelProvider;
let FakeModelProvider;
let InMemoryIndex;

function seed(index) {
  index.rebuildIndex({
    mode: "lexical",
    files: 2,
    chunks: [
      {
        id: 1,
        file: "notes/topic.md",
        ordinal: 0,
        line: 1,
        heading: "Topic",
        text: "Spaced repetition schedules reviews at increasing intervals.",
        hash: "h1",
      },
      {
        id: 2,
        file: "notes/other.md",
        ordinal: 0,
        line: 1,
        heading: "Other",
        text: "Unrelated note about cooking.",
        hash: "h2",
      },
    ],
  });
}

function makeReader(files) {
  return async (path) => {
    if (!(path in files)) throw new Error(`The source file is no longer available: ${path}`);
    return files[path];
  };
}

before(async () => {
  const engine = await import("../dist/index.js");
  const testing = await import("../dist/testing.js");
  runAskAgent = engine.runAskAgent;
  runAskSearchTool = engine.runAskSearchTool;
  runAgent = engine.runAgent;
  setModelProvider = engine.setModelProvider;
  resetModelProvider = engine.resetModelProvider;
  FakeModelProvider = testing.FakeModelProvider;
  InMemoryIndex = testing.InMemoryIndex;
});

after(() => resetModelProvider());

test("runAskAgent drives list → find → read and returns tool-gathered sources", async () => {
  const files = { "notes/topic.md": "# Topic\n\nBody about spaced repetition.\n" };
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async (_m, _msg, _t, turn) => {
        if (turn === 1) {
          return { content: "", toolCalls: [{ name: "find", arguments: { query: "spaced repetition", k: 4 } }] };
        }
        if (turn === 2) {
          return { content: "", toolCalls: [{ name: "read", arguments: { path: "notes/topic.md" } }] };
        }
        return { content: "Reviews use intervals [1].", toolCalls: [] };
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const result = await runAskAgent({
      index,
      question: "How does spaced repetition work?",
      mode: "lexical",
      readNote: makeReader(files),
      retrievalSeed: false,
    });
    assert.equal(result.stopReason, "done");
    assert.ok(result.sources.some((s) => s.file === "notes/topic.md"));
    assert.equal(result.seedHits.length, 0);
    assert.match(result.answer, /intervals/);
    assert.ok(result.grounded);
  } finally {
    index.close();
  }
});

test("runAskAgent records open anchors without reading the file", async () => {
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async (_m, _msg, _t, turn) => {
        if (turn === 1) {
          return {
            content: "",
            toolCalls: [{ name: "open", arguments: { path: "notes/topic.md", line: 3, heading: "Topic" } }],
          };
        }
        return { content: "See [1].", toolCalls: [] };
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const result = await runAskAgent({
      index,
      question: "Where is the topic?",
      mode: "lexical",
      readNote: makeReader({}),
      retrievalSeed: false,
    });
    assert.equal(result.opened.length, 1);
    assert.equal(result.opened[0].path, "notes/topic.md");
    assert.equal(result.opened[0].line, 3);
  } finally {
    index.close();
  }
});

test("retrievalSeed prepends optional hybrid hints when enabled", async () => {
  let sawSeed = false;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async (_m, messages) => {
        const user = messages.find((m) => m.role === "user")?.content ?? "";
        if (user.includes("OPTIONAL SEED")) sawSeed = true;
        return { content: "ok", toolCalls: [] };
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const result = await runAskAgent({
      index,
      question: "spaced repetition",
      mode: "lexical",
      readNote: makeReader({}),
      retrievalSeed: { k: 2 },
    });
    assert.ok(sawSeed);
    assert.ok(result.seedHits.length > 0);
  } finally {
    index.close();
  }
});

test("runAgent skips retrieval seed when retrievalSeed is false", async () => {
  let userMsg = "";
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async (_m, messages) => {
        userMsg = messages.find((m) => m.role === "user")?.content ?? "";
        return { content: "done", toolCalls: [] };
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    await runAgent({
      index,
      goal: "test",
      mode: "lexical",
      retrievalSeed: false,
      readNote: makeReader({}),
    });
    assert.match(userMsg, /No retrieval seed/);
    assert.doesNotMatch(userMsg, /^SOURCES:/m);
  } finally {
    index.close();
  }
});

test("grep tool matches indexed chunk text", async () => {
  const index = new InMemoryIndex();
  const state = { sources: [], opened: [] };
  try {
    seed(index);
    const out = await runAskSearchTool(
      "grep",
      { pattern: "cooking" },
      { index, readNote: async () => "", defaultMode: "lexical" },
      state,
    );
    assert.match(out, /other\.md/);
    assert.equal(state.sources.length, 1);
  } finally {
    index.close();
  }
});

test("find citation refs match deduped sources after overlapping tool calls", async () => {
  const index = new InMemoryIndex();
  const ctx = { index, readNote: async () => "", defaultMode: "lexical" };
  try {
    seed(index);
    const state = { sources: [], opened: [] };
    await runAskSearchTool("grep", { pattern: "cooking" }, ctx, state);
    assert.equal(state.sources.length, 1);

    const out = await runAskSearchTool("find", { query: "spaced repetition", k: 4 }, ctx, state);
    const parsed = JSON.parse(out);
    assert.equal(state.sources.length, 2);
    const topicHit = parsed.results.find((r) => r.file === "notes/topic.md");
    assert.equal(topicHit.ref, 2);

    const dupState = {
      sources: [
        {
          file: "notes/topic.md",
          line: 1,
          heading: "Topic",
          score: 1,
          cosine: 1,
          snippet: "existing",
          text: "existing",
          arms: "seed",
        },
      ],
      opened: [],
    };
    const dupOut = await runAskSearchTool("find", { query: "spaced repetition", k: 4 }, ctx, dupState);
    const dupParsed = JSON.parse(dupOut);
    assert.equal(dupState.sources.length, 1);
    assert.equal(dupParsed.results.find((r) => r.file === "notes/topic.md").ref, 1);
  } finally {
    index.close();
  }
});

test("list applies scope when listNotes is provided", async () => {
  const index = new InMemoryIndex();
  const state = { sources: [], opened: [] };
  try {
    seed(index);
    const listNotes = async () => ["notes/topic.md", "notes/other.md", "notes/excluded.md"];
    const out = await runAskSearchTool(
      "list",
      {},
      {
        index,
        readNote: async () => "",
        listNotes,
        scope: ["notes/topic.md", "notes/other.md"],
      },
      state,
    );
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.paths.sort(), ["notes/other.md", "notes/topic.md"]);
  } finally {
    index.close();
  }
});

test("list prefix with trailing slash matches folder notes", async () => {
  const index = new InMemoryIndex();
  const state = { sources: [], opened: [] };
  try {
    index.rebuildIndex({
      mode: "lexical",
      files: 2,
      chunks: [
        {
          id: 1,
          file: "notes/courses/a.md",
          ordinal: 0,
          line: 1,
          heading: "",
          text: "a",
          hash: "h1",
        },
        {
          id: 2,
          file: "notes/top.md",
          ordinal: 0,
          line: 1,
          heading: "",
          text: "b",
          hash: "h2",
        },
      ],
    });
    const out = await runAskSearchTool(
      "list",
      { prefix: "notes/" },
      { index, readNote: async () => "", defaultMode: "lexical" },
      state,
    );
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.paths.sort(), ["notes/courses/a.md", "notes/top.md"]);
  } finally {
    index.close();
  }
});

test("runAskAgent fails fast when the first turn returns no tool calls", async () => {
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async () => ({ content: "I know the answer.", toolCalls: [] }),
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const result = await runAskAgent({
      index,
      question: "anything",
      mode: "lexical",
      readNote: makeReader({}),
      retrievalSeed: false,
    });
    assert.equal(result.stopReason, "no-tool-use");
    assert.equal(result.steps, 1);
    assert.match(result.answer, /I know the answer/);
    assert.equal(result.sources.length, 0);
  } finally {
    index.close();
  }
});

test("runAskAgent passes a bounded timeoutMs on the first tool turn", async () => {
  let sawTimeout;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async (_m, _msg, _t, _turn, options) => {
        sawTimeout = options?.timeoutMs;
        return { content: "ok", toolCalls: [] };
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    await runAskAgent({
      index,
      question: "x",
      mode: "lexical",
      readNote: makeReader({}),
      retrievalSeed: false,
      wallMs: 60_000,
    });
    assert.equal(sawTimeout, 60_000);
  } finally {
    index.close();
  }
});

test("runAskAgent maps first-turn Ollama timeout to no-tool-use when nothing was gathered", async () => {
  const { OllamaTimeoutError } = await import("../dist/index.js");
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async () => {
        throw new OllamaTimeoutError("chat-with-tools", 180_000);
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const result = await runAskAgent({
      index,
      question: "anything",
      mode: "lexical",
      readNote: makeReader({}),
      retrievalSeed: false,
    });
    assert.equal(result.stopReason, "no-tool-use");
    assert.equal(result.steps, 1);
    assert.match(result.answer, /timed out waiting for the model to call search tools/i);
  } finally {
    index.close();
  }
});

test("runAskAgent stops with timeout when wallMs elapses before the model answers", async () => {
  let called = 0;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async () => {
        called++;
        return { content: "should not run", toolCalls: [] };
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const result = await runAskAgent({
      index,
      question: "anything",
      mode: "lexical",
      readNote: makeReader({}),
      wallMs: 0,
      stepCap: 16,
    });
    assert.equal(result.stopReason, "timeout");
    assert.equal(called, 0);
    assert.equal(result.steps, 0);
    assert.match(result.answer, /timed out/i);
  } finally {
    index.close();
  }
});
