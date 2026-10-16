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

const COPPER_QUESTION = "What is the COPPER FINCH number?";
const COPPER_ROSTER = "COPPER FINCH is listed on the field roster beside other codenames.";
const COPPER_FACT = "The unique cairn-alpha phrase is COPPER FINCH, 312.";
const COPPER_CITED = "The number is 312. [alpha-notes.md:1]";

function indexCopper(index) {
  index.rebuildIndex({
    mode: "lexical",
    files: 2,
    chunks: [
      { id: 1, file: "finch-roster.md", ordinal: 0, line: 2, heading: "Roster", text: COPPER_ROSTER, hash: "roster" },
      { id: 2, file: "alpha-notes.md", ordinal: 0, line: 1, heading: "Field notes", text: COPPER_FACT, hash: "alpha" },
    ],
  });
}

function forcedFind(messages) {
  return messages.find((message) => message.role === "tool" && message.toolCallId === "cairn_forced_find");
}

/** Held draft tokens never reach the renderer, and nothing streams before the forced find. */
function assertDraftHeld(events, held) {
  const findAt = events.findIndex((event) => event.kind === "tool" && event.name === "find");
  assert.ok(findAt >= 0);
  assert.equal(
    events.slice(0, findAt).some((event) => event.kind === "token" || event.kind === "clear-answer"),
    false,
  );
  const shown = events
    .filter((event) => event.kind === "token")
    .map((event) => event.token)
    .join("");
  assert.equal(shown.includes(held), false);
  assert.match(shown, /312/);
  assert.match(shown, /alpha-notes\.md:1/);
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

test("runAskAgent emits onProgress for status and tool steps", async () => {
  const events = [];
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async (_m, _msg, _t, turn) => {
        if (turn === 1) {
          return { content: "", toolCalls: [{ name: "grep", arguments: { pattern: "cooking" } }] };
        }
        return { content: "ok", toolCalls: [] };
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    await runAskAgent({
      index,
      question: "food?",
      mode: "lexical",
      readNote: makeReader({}),
      retrievalSeed: false,
      onProgress: (e) => events.push(e),
    });
    assert.ok(events.some((e) => e.kind === "status"));
    assert.ok(events.some((e) => e.kind === "tool" && e.name === "grep"));
  } finally {
    index.close();
  }
});

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
    assert.equal(state.sources[0].line, 1);
    assert.equal(state.sources[0].heading, "Other");
  } finally {
    index.close();
  }
});

test("grep records the matched line and enclosing heading inside a chunk", async () => {
  const { chunkMarkdown } = await import("../dist/chunk.js");
  const deep = [
    "zebra in the preamble.",
    "",
    "# Title",
    "",
    "Intro line.",
    "",
    "## Section A",
    "",
    "Alpha body.",
    "",
    "## Section B",
    "",
    "Deep copper finch under B.",
  ].join("\n");
  const heron = [
    "# Project Heron",
    "",
    "Status notes for the heron effort.",
    "",
    "Preamble before either section.",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "## Section A",
    "",
    "Earlier draft.",
    "",
    "",
    "",
    "",
    "",
    "## Section B",
    "",
    "The unique cairn-alpha phrase is COPPER FINCH, 312.",
  ].join("\n");
  assert.equal(heron.split("\n")[20], "## Section B");

  const index = new InMemoryIndex();
  try {
    const heronChunks = await chunkMarkdown(heron);
    assert.equal(heronChunks.length, 1);
    assert.equal(heronChunks[0].line, 1);
    index.rebuildIndex({
      mode: "lexical",
      files: 2,
      chunks: [
        {
          id: 1,
          file: "notes/deep.md",
          ordinal: 0,
          line: 1,
          heading: "",
          text: deep,
          hash: "deep",
        },
        {
          id: 2,
          file: "notes/continued.md",
          ordinal: 1,
          line: 30,
          heading: "Section A",
          text: "still the same section.\nquartz appears here.\n",
          hash: "cont",
        },
        {
          id: 3,
          file: "project-heron.md",
          ordinal: 0,
          line: heronChunks[0].line,
          heading: heronChunks[0].heading,
          text: heronChunks[0].text,
          hash: "heron",
        },
      ],
    });
    const ctx = { index, readNote: async () => "", defaultMode: "lexical" };

    const sectionB = JSON.parse(
      await runAskSearchTool("grep", { pattern: "Section B", path: "notes/deep.md" }, ctx, {
        sources: [],
        opened: [],
      }),
    );
    assert.equal(sectionB.matches.length, 1);
    assert.equal(sectionB.matches[0].line, 11);
    assert.equal(sectionB.matches[0].heading, "Section B");

    const deepBody = JSON.parse(
      await runAskSearchTool("grep", { pattern: "Deep copper", path: "notes/deep.md" }, ctx, {
        sources: [],
        opened: [],
      }),
    );
    assert.equal(deepBody.matches[0].line, 13);
    assert.equal(deepBody.matches[0].heading, "Section B");

    const alpha = JSON.parse(
      await runAskSearchTool("grep", { pattern: "Alpha body", path: "notes/deep.md" }, ctx, {
        sources: [],
        opened: [],
      }),
    );
    assert.equal(alpha.matches[0].line, 9);
    assert.equal(alpha.matches[0].heading, "Section A");

    const preamble = JSON.parse(
      await runAskSearchTool("grep", { pattern: "zebra", path: "notes/deep.md" }, ctx, {
        sources: [],
        opened: [],
      }),
    );
    assert.equal(preamble.matches[0].line, 1);
    assert.equal(preamble.matches[0].heading, undefined);

    const continued = JSON.parse(
      await runAskSearchTool("grep", { pattern: "quartz", path: "notes/continued.md" }, ctx, {
        sources: [],
        opened: [],
      }),
    );
    assert.equal(continued.matches[0].line, 31);
    assert.equal(continued.matches[0].heading, "Section A");

    const heronGrep = { sources: [], opened: [] };
    const heronOut = JSON.parse(
      await runAskSearchTool("grep", { pattern: "Section B", path: "project-heron.md" }, ctx, heronGrep),
    );
    assert.equal(heronOut.matches[0].line, 21);
    assert.equal(heronOut.matches[0].heading, "Section B");
    assert.equal(heronGrep.sources[0].line, 21);
    assert.equal(heronGrep.sources[0].heading, "Section B");
    assert.equal(heronGrep.sources[0].arms, "grep");
    assert.notEqual(
      `${heronGrep.sources[0].file}:${heronGrep.sources[0].line}:${heronGrep.sources[0].heading}`,
      `project-heron.md:1:${heronChunks[0].heading}`,
    );
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

test("a first reply with no tool call searches the question before answering or missing", async () => {
  const seen = [];
  const events = [];
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async (_model, messages, _tools, turn, options) => {
        seen.push({
          turn,
          tools: messages.filter((message) => message.role === "tool").map((message) => message.toolName),
          find: messages.find((message) => message.role === "assistant" && message.toolCalls?.length)?.toolCalls?.[0],
        });
        if (turn === 1) {
          options?.onToken?.("Your notes don't cover this.");
          return { content: "Your notes don't cover this.", toolCalls: [] };
        }
        const found = forcedFind(messages);
        assert.ok(found);
        assert.match(found.content, /alpha-notes\.md/);
        assert.match(found.content, /312/);
        options?.onToken?.(COPPER_CITED);
        return { content: COPPER_CITED, toolCalls: [] };
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    indexCopper(index);
    const result = await runAskAgent({
      index,
      question: COPPER_QUESTION,
      mode: "lexical",
      readNote: makeReader({ "finch-roster.md": COPPER_ROSTER, "alpha-notes.md": COPPER_FACT }),
      retrievalSeed: false,
      onProgress: (event) => events.push(event),
    });
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[0].tools, []);
    assert.equal(seen[1].find?.name, "find");
    assert.equal(seen[1].find?.id, "cairn_forced_find");
    assert.equal(seen[1].find?.arguments.query, COPPER_QUESTION);
    assert.deepEqual(seen[1].tools, ["find"]);
    assert.equal(result.stopReason, "done");
    assert.equal(result.answer, COPPER_CITED);
    assert.match(result.answer, /312/);
    assert.match(result.answer, /alpha-notes\.md:1/);
    assert.equal(result.sources.some((source) => source.file === "alpha-notes.md"), true);
    assertDraftHeld(events, "Your notes don't cover this.");
  } finally {
    index.close();
  }
});

test("a turn that already searched does not add another search", async () => {
  let calls = 0;
  let answerCallOpen = false;
  let tokenDuringAnswerCall = false;
  const events = [];
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async (_model, messages, _tools, turn, options) => {
        calls += 1;
        if (turn === 1) {
          return { content: "", toolCalls: [{ name: "find", arguments: { query: "spaced repetition" } }] };
        }
        const finds = messages.filter((message) => message.role === "assistant" && message.toolCalls?.some((call) => call.name === "find"));
        assert.equal(finds.length, 1);
        assert.equal(finds[0].toolCalls[0].id, undefined);
        assert.equal(finds[0].toolCalls[0].arguments.query, "spaced repetition");
        assert.equal(messages.filter((message) => message.role === "tool" && message.toolName === "find").length, 1);
        assert.equal(messages.some((message) => message.toolCallId === "cairn_forced_find"), false);
        answerCallOpen = true;
        options?.onToken?.("Reviews use intervals.");
        answerCallOpen = false;
        return { content: "Reviews use intervals.", toolCalls: [] };
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
      readNote: makeReader({}),
      retrievalSeed: false,
      onProgress: (event) => {
        events.push(event);
        if (event.kind === "token" && answerCallOpen) tokenDuringAnswerCall = true;
      },
    });
    assert.equal(calls, 2);
    assert.equal(result.steps, 2);
    assert.equal(tokenDuringAnswerCall, true);
    assert.equal(events.filter((event) => event.kind === "tool" && event.name === "find").length, 1);
    assert.equal(result.answer, "Reviews use intervals.");
    assert.equal(result.sources.some((source) => source.file === "notes/topic.md"), true);
  } finally {
    index.close();
  }
});

test("list then the exact miss still searches once and cites alpha-notes", async () => {
  let calls = 0;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async (_model, messages, _tools, turn) => {
        calls += 1;
        if (turn === 1) return { content: "", toolCalls: [{ name: "list", arguments: { prefix: "notes" } }] };
        if (turn === 2) return { content: "Your notes don't cover this.", toolCalls: [] };
        const found = forcedFind(messages);
        assert.ok(found);
        assert.match(found.content, /alpha-notes\.md/);
        assert.match(found.content, /312/);
        return { content: COPPER_CITED, toolCalls: [] };
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    indexCopper(index);
    const result = await runAskAgent({
      index,
      question: COPPER_QUESTION,
      mode: "lexical",
      readNote: makeReader({ "finch-roster.md": COPPER_ROSTER, "alpha-notes.md": COPPER_FACT }),
      retrievalSeed: false,
    });
    assert.equal(calls, 3);
    assert.equal(result.answer, COPPER_CITED);
    assert.match(result.answer, /312/);
    assert.match(result.answer, /alpha-notes\.md:1/);
    assert.equal(result.sources.some((source) => source.file === "alpha-notes.md"), true);
  } finally {
    index.close();
  }
});

test("a reworded miss after reading the finch-roster decoy still searches and cites alpha-notes", async () => {
  const reworded = "There is no specific number provided for the COPPER FINCH codename";
  const events = [];
  let calls = 0;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async (_model, messages, _tools, turn, options) => {
        calls += 1;
        if (turn === 1) return { content: "", toolCalls: [{ name: "read", arguments: { path: "finch-roster.md" } }] };
        if (turn === 2) {
          options?.onToken?.(reworded);
          return { content: reworded, toolCalls: [] };
        }
        const found = forcedFind(messages);
        assert.ok(found);
        assert.match(found.content, /alpha-notes\.md/);
        assert.match(found.content, /312/);
        options?.onToken?.(COPPER_CITED);
        return { content: COPPER_CITED, toolCalls: [] };
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    indexCopper(index);
    const result = await runAskAgent({
      index,
      question: COPPER_QUESTION,
      mode: "lexical",
      readNote: makeReader({ "finch-roster.md": COPPER_ROSTER, "alpha-notes.md": COPPER_FACT }),
      retrievalSeed: false,
      onProgress: (event) => events.push(event),
    });
    assert.equal(calls, 3);
    assert.equal(result.answer, COPPER_CITED);
    assert.match(result.answer, /312/);
    assert.match(result.answer, /alpha-notes\.md:1/);
    assert.equal(result.answer.includes(reworded), false);
    assert.equal(result.sources.some((source) => source.file === "alpha-notes.md"), true);
    assertDraftHeld(events, reworded);
  } finally {
    index.close();
  }
});

test("a confident decoy answer after list and read still searches and cites alpha-notes", async () => {
  const decoy = "alpha track";
  const events = [];
  let calls = 0;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async (_model, messages, _tools, turn, options) => {
        calls += 1;
        if (turn === 1) return { content: "", toolCalls: [{ name: "list", arguments: {} }] };
        if (turn === 2) return { content: "", toolCalls: [{ name: "read", arguments: { path: "finch-roster.md" } }] };
        if (turn === 3) {
          options?.onToken?.(decoy);
          return { content: decoy, toolCalls: [] };
        }
        const found = forcedFind(messages);
        assert.ok(found);
        assert.match(found.content, /alpha-notes\.md/);
        assert.match(found.content, /312/);
        options?.onToken?.(COPPER_CITED);
        return { content: COPPER_CITED, toolCalls: [] };
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    indexCopper(index);
    const result = await runAskAgent({
      index,
      question: COPPER_QUESTION,
      mode: "lexical",
      readNote: makeReader({ "finch-roster.md": COPPER_ROSTER, "alpha-notes.md": COPPER_FACT }),
      retrievalSeed: false,
      onProgress: (event) => events.push(event),
    });
    assert.equal(calls, 4);
    assert.equal(result.answer, COPPER_CITED);
    assert.match(result.answer, /312/);
    assert.match(result.answer, /alpha-notes\.md:1/);
    assert.equal(result.answer.includes(decoy), false);
    assert.equal(result.sources.some((source) => source.file === "alpha-notes.md"), true);
    assertDraftHeld(events, decoy);
  } finally {
    index.close();
  }
});

test("a text answer after the forced search does not search again", async () => {
  let calls = 0;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async (_model, messages, _tools, turn) => {
        calls += 1;
        const finds = messages.filter((message) => message.role === "tool" && message.toolName === "find");
        if (turn === 1) return { content: "Your notes don't cover this.", toolCalls: [] };
        assert.equal(finds.length, 1);
        assert.equal(finds[0].toolCallId, "cairn_forced_find");
        return { content: "Your notes don't cover this.", toolCalls: [] };
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const result = await runAskAgent({
      index,
      question: "zzzzqqq",
      mode: "lexical",
      readNote: makeReader({}),
      retrievalSeed: false,
    });
    assert.equal(calls, 2);
    assert.equal(result.steps, 2);
    assert.equal(result.answer, "Your notes don't cover this.");
  } finally {
    index.close();
  }
});

test("a turn that already grepped does not add a find", async () => {
  let calls = 0;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async (_model, messages, _tools, turn) => {
        calls += 1;
        if (turn === 1) return { content: "", toolCalls: [{ name: "grep", arguments: { pattern: "cooking" } }] };
        assert.equal(messages.some((message) => message.toolName === "find"), false);
        return { content: "Unrelated note about cooking.", toolCalls: [] };
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const result = await runAskAgent({
      index,
      question: "cooking",
      mode: "lexical",
      readNote: makeReader({}),
      retrievalSeed: false,
    });
    assert.equal(calls, 2);
    assert.equal(result.steps, 2);
    assert.equal(result.answer, "Unrelated note about cooking.");
  } finally {
    index.close();
  }
});

test("a miss after a search with no results shows no chips", async () => {
  const question = "zzzzqqq";
  let calls = 0;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async (_model, messages, _tools, turn) => {
        calls += 1;
        if (turn === 1) return { content: "Your notes don't cover this.", toolCalls: [] };
        const find = messages.find((message) => message.role === "tool" && message.toolName === "find");
        assert.ok(find);
        assert.match(find.content, /"results":\[\]/);
        return { content: "Your notes don't cover this.", toolCalls: [] };
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const result = await runAskAgent({
      index,
      question,
      mode: "lexical",
      readNote: makeReader({}),
      retrievalSeed: false,
    });
    assert.equal(calls, 2);
    assert.equal(result.stopReason, "done");
    assert.equal(result.answer, "Your notes don't cover this.");
    assert.deepEqual(result.sources, []);
    assert.deepEqual(result.opened, []);
    assert.equal(result.grounded, false);
  } finally {
    index.close();
  }
});

test("runAskAgent passes a bounded timeoutMs on the first tool turn", async () => {
  let sawTimeout;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async (_m, _msg, _t, turn, options) => {
        if (turn === 1) sawTimeout = options?.timeoutMs;
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
    // timeoutMs is the wall deadline minus elapsed time, so it can be a few ms under 60000.
    assert.equal(typeof sawTimeout, "number");
    assert.ok(
      sawTimeout > 59_000 && sawTimeout <= 60_000,
      `timeoutMs ${sawTimeout} outside (59000, 60000]`,
    );
  } finally {
    index.close();
  }
});

test("runAskAgent maps first-turn Ollama timeout to the plain try-8b message", async () => {
  const { OllamaTimeoutError } = await import("../dist/index.js");
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async () => {
        throw new OllamaTimeoutError("chat-with-tools", 90_000);
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
    assert.equal(result.answer, "This model couldn't complete the search. Try qwen3:8b.");
    assert.deepEqual(result.sources, []);
    assert.deepEqual(result.opened, []);
  } finally {
    index.close();
  }
});

test("runAskAgent caps the first tool-call timeout at 90s", async () => {
  let sawTimeout;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async (_m, _msg, _t, turn, options) => {
        if (turn === 1) sawTimeout = options?.timeoutMs;
        return { content: "ok", toolCalls: [] };
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    await runAskAgent({
      index,
      question: "food?",
      mode: "lexical",
      readNote: makeReader({}),
      retrievalSeed: false,
    });
    assert.equal(typeof sawTimeout, "number");
    assert.ok(sawTimeout <= 90_000, `timeoutMs ${sawTimeout} exceeds 90000`);
    assert.ok(sawTimeout > 89_000, `timeoutMs ${sawTimeout} is not the 90s first-turn cap`);
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

test("answer tokens are delivered before the turn resolves", async () => {
  const events = [];
  let settled = false;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:8b"],
      chatWithTools: async (_m, _msg, _t, turn, options) => {
        if (turn === 1) {
          return { content: "", toolCalls: [{ name: "grep", arguments: { pattern: "cooking" } }] };
        }
        assert.equal(settled, false);
        options?.onToken?.("The ");
        assert.equal(settled, false);
        options?.onToken?.("note says intervals.");
        return { content: "The note says intervals.", toolCalls: [] };
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const result = await runAskAgent({
      index,
      question: "food?",
      mode: "lexical",
      readNote: makeReader({}),
      onProgress: (event) => events.push(event),
    });
    settled = true;
    assert.equal(result.answer, "The note says intervals.");
    assert.equal(result.stopReason, "done");
    assert.deepEqual(
      events.filter((event) => event.kind === "token").map((event) => event.token),
      ["The ", "note says intervals."],
    );
  } finally {
    index.close();
  }
});

test("a tool turn clears streamed preamble and the answer is the later text", async () => {
  const events = [];
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:8b"],
      chatWithTools: async (_m, _msg, _t, turn, options) => {
        if (turn === 1) {
          return { content: "", toolCalls: [{ name: "grep", arguments: { pattern: "cooking" } }] };
        }
        if (turn === 2) {
          options?.onToken?.("Looking. ");
          return {
            content: "Looking. ",
            toolCalls: [{ name: "read", arguments: { path: "notes/topic.md" } }],
          };
        }
        options?.onToken?.("Intervals.");
        return { content: "Intervals.", toolCalls: [] };
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const result = await runAskAgent({
      index,
      question: "food?",
      mode: "lexical",
      readNote: makeReader({
        "notes/topic.md": "Spaced repetition schedules reviews at increasing intervals.",
      }),
      onProgress: (event) => events.push(event.kind === "token" ? `token:${event.token}` : event.kind),
    });
    assert.equal(result.answer, "Intervals.");
    assert.equal(events.includes("token:Looking. "), true);
    assert.equal(events.includes("clear-answer"), true);
    assert.equal(events.indexOf("token:Looking. ") < events.indexOf("clear-answer"), true);
    assert.equal(events.indexOf("clear-answer") < events.indexOf("token:Intervals."), true);
  } finally {
    index.close();
  }
});

test("a streamed answer that ends as a miss leaves only the miss text and 0 chips", async () => {
  const { VIDEO_NO_TEXT } = await import("../dist/index.js");
  const streamed = [];
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:8b"],
      chatWithTools: async (_m, _msg, _t, turn, options) => {
        if (turn === 1) {
          return { content: "", toolCalls: [{ name: "read", arguments: { path: "clip.mp4" } }] };
        }
        options?.onToken?.("The clip says hello.");
        return { content: "The clip says hello.", toolCalls: [] };
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const result = await runAskAgent({
      index,
      question: "Summarize the vault",
      mode: "lexical",
      readNote: async (path) => {
        if (path === "clip.mp4") throw new Error(VIDEO_NO_TEXT);
        throw new Error(`missing ${path}`);
      },
      onProgress: (event) => {
        if (event.kind === "token") streamed.push(event.token);
      },
    });
    assert.deepEqual(streamed, ["The clip says hello."]);
    assert.equal(result.answer, "Your notes don't cover this.");
    assert.equal(result.answer.includes("hello"), false);
    assert.equal(result.sources.length, 0);
    assert.deepEqual(result.opened, []);
    assert.equal(result.grounded, false);
    assert.equal(result.stopReason, "done");
  } finally {
    index.close();
  }
});

test("cancelling mid-stream stops the loop with no answer and no chips", async () => {
  const ac = new AbortController();
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:8b"],
      chatWithTools: async (_m, _msg, _t, turn, options) => {
        if (turn === 1) {
          return { content: "", toolCalls: [{ name: "grep", arguments: { pattern: "cooking" } }] };
        }
        options?.onToken?.("Partial ");
        ac.abort();
        throw new DOMException("The operation was aborted.", "AbortError");
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const result = await runAskAgent({
      index,
      question: "food?",
      mode: "lexical",
      readNote: makeReader({}),
      signal: ac.signal,
    });
    assert.equal(result.stopReason, "cancelled");
    assert.equal(result.answer, "");
    assert.equal(result.sources.length, 0);
    assert.deepEqual(result.opened, []);
  } finally {
    index.close();
  }
});
