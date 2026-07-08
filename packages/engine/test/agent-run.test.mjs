import assert from "node:assert/strict";
import { after, before, test } from "node:test";

let runAgent;
let diffLines;
let DEFAULT_AGENT_STEP_CAP;
let setModelProvider;
let resetModelProvider;
let FakeModelProvider;
let InMemoryIndex;

// Lexical index so retrieval runs without embeddings.
function seed(index) {
  index.rebuildIndex({
    mode: "lexical",
    files: 1,
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
    ],
  });
}

// A reader over an in-memory vault — the engine gets NO filesystem handle, which is
// exactly how it is prevented from writing.
function makeReader(files) {
  return async (path) => {
    if (!(path in files)) throw new Error(`The source file is no longer available: ${path}`);
    return files[path];
  };
}

before(async () => {
  const engine = await import("../dist/index.js");
  const testing = await import("../dist/testing.js");
  runAgent = engine.runAgent;
  diffLines = engine.diffLines;
  DEFAULT_AGENT_STEP_CAP = engine.DEFAULT_AGENT_STEP_CAP;
  setModelProvider = engine.setModelProvider;
  resetModelProvider = engine.resetModelProvider;
  FakeModelProvider = testing.FakeModelProvider;
  InMemoryIndex = testing.InMemoryIndex;
});

after(() => resetModelProvider());

test("runAgent collects a proposed edit as a pending diff and never writes", async () => {
  const files = { "notes/topic.md": "# Topic\n\nOld body.\n" };
  const readCalls = [];
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async (_model, _messages, _tools, turn) => {
        if (turn === 1) {
          return { content: "", toolCalls: [{ name: "read_note", arguments: { path: "notes/topic.md" } }] };
        }
        if (turn === 2) {
          return {
            content: "",
            toolCalls: [
              {
                name: "propose_edit",
                arguments: { path: "notes/topic.md", newContent: "# Topic\n\nNew grounded body [1].\n" },
              },
            ],
          };
        }
        return { content: "Proposed one edit to notes/topic.md, grounded in [1].", toolCalls: [] };
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const result = await runAgent({
      index,
      goal: "Rewrite the spaced repetition note using the sources.",
      mode: "lexical",
      readNote: async (p) => {
        readCalls.push(p);
        return files[p];
      },
    });

    assert.equal(result.stopReason, "done");
    assert.equal(result.proposals.length, 1);
    const p = result.proposals[0];
    assert.equal(p.path, "notes/topic.md");
    assert.equal(p.op, "modify");
    assert.equal(p.newContent, "# Topic\n\nNew grounded body [1].\n");
    assert.ok(p.baseHash.length === 64, "modify proposal carries the base content hash");
    assert.ok(p.preview.added > 0 && p.preview.removed > 0);
    assert.match(result.answer, /Proposed one edit/);
    assert.ok(result.grounded);

    // The invariant: the in-memory vault is byte-identical — the loop only read.
    assert.equal(files["notes/topic.md"], "# Topic\n\nOld body.\n");
    assert.ok(readCalls.includes("notes/topic.md"));
  } finally {
    index.close();
  }
});

test("a new-file proposal is op:add with an empty baseHash", async () => {
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async (_m, _msg, _t, turn) => {
        if (turn === 1) {
          return {
            content: "",
            toolCalls: [
              { name: "propose_edit", arguments: { path: "notes/new.md", newContent: "# New\n\nFrom [1].\n" } },
            ],
          };
        }
        return { content: "Created a new note.", toolCalls: [] };
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const result = await runAgent({
      index,
      goal: "Make a new note",
      mode: "lexical",
      readNote: async () => {
        throw new Error("The source file is no longer available");
      },
    });
    assert.equal(result.proposals.length, 1);
    assert.equal(result.proposals[0].op, "add");
    assert.equal(result.proposals[0].baseHash, "");
    assert.equal(result.proposals[0].preview.removed, 0);
  } finally {
    index.close();
  }
});

test("runAgent hard-stops at the step cap without applying anything", async () => {
  let turns = 0;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      // A pathological model that never stops calling tools.
      chatWithTools: async () => {
        turns++;
        return { content: "", toolCalls: [{ name: "read_note", arguments: { path: "notes/topic.md" } }] };
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const result = await runAgent({
      index,
      goal: "loop forever",
      mode: "lexical",
      stepCap: 4,
      readNote: makeReader({ "notes/topic.md": "body" }),
    });
    assert.equal(result.stopReason, "step-cap");
    assert.equal(result.steps, 4);
    assert.equal(turns, 4, "the model is not called again after the cap");
    assert.equal(result.proposals.length, 0);
  } finally {
    index.close();
  }
});

test("the default step cap is 25 (ADR-0008)", () => {
  assert.equal(DEFAULT_AGENT_STEP_CAP, 25);
});

test("a provider without tool support degrades to a clean refusal, not a silent no-op", async () => {
  setModelProvider(new FakeModelProvider({ models: ["qwen3:4b"] })); // no chatWithTools script
  const index = new InMemoryIndex();
  try {
    seed(index);
    const result = await runAgent({
      index,
      goal: "do something",
      mode: "lexical",
      readNote: makeReader({}),
    });
    assert.equal(result.stopReason, "no-tool-support");
    assert.equal(result.proposals.length, 0);
    assert.match(result.answer, /tool-calling/i);
  } finally {
    index.close();
  }
});

test("malformed propose_edit args are rejected without producing a proposal", async () => {
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async (_m, _msg, _t, turn) => {
        if (turn === 1) {
          // path present but newContent missing — must not become a proposal.
          return { content: "", toolCalls: [{ name: "propose_edit", arguments: { path: "notes/x.md" } }] };
        }
        return { content: "done", toolCalls: [] };
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const result = await runAgent({ index, goal: "x", mode: "lexical", readNote: makeReader({}) });
    assert.equal(result.proposals.length, 0);
    assert.equal(result.stopReason, "done");
  } finally {
    index.close();
  }
});

test("diffLines counts added and removed lines and marks context", () => {
  const d = diffLines("a\nb\nc\n", "a\nB\nc\nd\n");
  assert.equal(d.added, 2); // "B" and "d"
  assert.equal(d.removed, 1); // "b"
  assert.ok(d.lines.some((l) => l.type === "context" && l.text === "a"));
  assert.ok(d.lines.some((l) => l.type === "add" && l.text === "d"));
});
