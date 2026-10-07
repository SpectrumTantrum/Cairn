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
