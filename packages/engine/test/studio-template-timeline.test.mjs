import assert from "node:assert/strict";
import { after, before, test } from "node:test";

let generateStudioNote;
let getStudioTemplate;
let setModelProvider;
let resetModelProvider;
let FakeModelProvider;
let InMemoryIndex;

// Lexical-only index (no vectors) so retrieval + coverage run without embeddings.
function seed(index) {
  index.rebuildIndex({
    mode: "lexical",
    files: 1,
    chunks: [
      {
        id: 1,
        file: "notes/apollo.md",
        ordinal: 0,
        line: 5,
        heading: "Apollo program",
        text: "In 1961 President Kennedy set the goal of a crewed Moon landing. Apollo 11 landed on the Moon in July 1969, and the program's later missions followed before it ended.",
        hash: "h1",
      },
    ],
  });
}

before(async () => {
  const engine = await import("../dist/index.js");
  const testing = await import("../dist/testing.js");
  generateStudioNote = engine.generateStudioNote;
  getStudioTemplate = engine.getStudioTemplate;
  setModelProvider = engine.setModelProvider;
  resetModelProvider = engine.resetModelProvider;
  FakeModelProvider = testing.FakeModelProvider;
  InMemoryIndex = testing.InMemoryIndex;
});

after(() => resetModelProvider());

test("the timeline template is enabled and carries the chronological structure scaffold", () => {
  const template = getStudioTemplate("timeline");
  assert.ok(template, "timeline is registered");
  assert.equal(template.enabled, true);
  assert.ok(template.prompt, "the enabled timeline carries a prompt scaffold");
  assert.equal(template.prompt.filenameStem, "Timeline");
  // Structure guidance: chronological ordering, dates only as stated, relative ordering
  // fallback, and a Gaps-in-the-record close.
  assert.match(template.prompt.structure, /## Timeline/);
  assert.match(template.prompt.structure, /chronological/i);
  assert.match(template.prompt.structure, /AS STATED IN THE SOURCES/);
  assert.match(template.prompt.structure, /never invent, infer, or approximate a date/i);
  assert.match(template.prompt.structure, /relative ordering language/i);
  assert.match(template.prompt.structure, /## Gaps in the record/);
});

test("generateStudioNote produces a cited Timeline note whose prompt carries the structure guidance", async () => {
  let capturedSystem;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chat: async (_model, messages) => {
        capturedSystem = messages.find((m) => m.role === "system")?.content ?? "";
        return [
          "## Timeline",
          "",
          "- 1961 — President Kennedy set the goal of a crewed Moon landing [1].",
          "- July 1969 — Apollo 11 landed on the Moon [1].",
          "- Later — subsequent Apollo missions followed before the program ended [1].",
          "",
          "## Gaps in the record",
          "",
          "The sources do not detail the individual later missions or the exact end date [1].",
        ].join("\n");
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const result = await generateStudioNote({
      index,
      templateId: "timeline",
      topic: "Apollo program",
      mode: "lexical",
    });

    assert.equal(result.grounded, true);
    assert.equal(result.covered, true);
    assert.equal(result.template, "timeline");
    assert.ok(result.note, "a note is proposed");

    // Filename stem comes from the template.
    assert.match(result.note.path, /^Timeline - Apollo program\.md$/);
    assert.match(result.note.content, /^# Timeline: Apollo program/);
    assert.match(result.note.content, /## Timeline/);
    assert.match(result.note.content, /## Gaps in the record/);

    // The per-template structure guidance reaches the model's system prompt.
    assert.match(capturedSystem, /## Timeline/);
    assert.match(capturedSystem, /AS STATED IN THE SOURCES/);
    assert.match(capturedSystem, /never invent, infer, or approximate a date/i);
    assert.match(capturedSystem, /relative ordering language/i);
    assert.match(capturedSystem, /## Gaps in the record/);

    // Citation spine: inline citation AND a deterministic Sources block from the real hit.
    assert.match(result.note.content, /\[1\]/);
    assert.match(result.note.content, /## Sources/);
    assert.match(result.note.content, /\[\[notes\/apollo\.md\]\]/);
    assert.ok(result.sources.length > 0);
    assert.equal(result.sources[0].file, "notes/apollo.md");
  } finally {
    index.close();
  }
});
