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
        file: "notes/spacing.md",
        ordinal: 0,
        line: 3,
        heading: "Spacing",
        text: "Spaced repetition schedules reviews at increasing intervals to fight forgetting.",
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

test("mind-map template is enabled and carries a prompt with the Mind Map filename stem", () => {
  const template = getStudioTemplate("mind-map");
  assert.ok(template, "mind-map is registered");
  assert.equal(template.enabled, true);
  assert.ok(template.prompt, "the enabled template carries a prompt scaffold");
  assert.equal(template.prompt.filenameStem, "Mind Map");
  // At alpha this is a TEXT outline — the scaffold asks for a Markdown outline and explicitly
  // steers the model AWAY from any interactive canvas/graph output.
  assert.match(template.prompt.structure, /hierarchical Markdown OUTLINE/);
  assert.match(template.prompt.structure, /text outline, NOT an interactive canvas/i);
});

test("generateStudioNote builds a mind-map note: hierarchical outline + citations back to sources", async () => {
  let captured = null;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chat: async (_model, messages) => {
        captured = messages;
        return [
          "## Spaced repetition",
          "",
          "### Scheduling",
          "",
          "- Increasing intervals [1]",
          "  - Fights forgetting [1]",
          "",
          "### Purpose",
          "",
          "- Retention [1]",
        ].join("\n");
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const result = await generateStudioNote({
      index,
      templateId: "mind-map",
      topic: "spaced repetition",
      mode: "lexical",
    });

    assert.equal(result.grounded, true);
    assert.equal(result.covered, true);
    assert.equal(result.template, "mind-map");
    assert.ok(result.note, "a note is proposed");

    // Filename stem: "Mind Map - <topic>.md".
    assert.match(result.note.path, /^Mind Map - spaced repetition\.md$/);
    assert.match(result.note.content, /^# Mind Map: spaced repetition/);

    // Citation spine: inline citation AND a deterministic Sources block from the real hits.
    assert.match(result.note.content, /\[1\]/);
    assert.match(result.note.content, /## Sources/);
    assert.match(result.note.content, /\[\[notes\/spacing\.md\]\]/);
    assert.ok(result.sources.length > 0);
    assert.equal(result.sources[0].file, "notes/spacing.md");

    // The per-template structure guidance reached the model: a hierarchical outline of a
    // central root topic, branch subheadings, nested leaf bullets, short labels — a TEXT
    // outline, never an interactive canvas.
    const structurePrompt = captured[0].content;
    assert.match(structurePrompt, /MIND MAP/);
    assert.match(structurePrompt, /hierarchical Markdown OUTLINE/);
    assert.match(structurePrompt, /root heading/i);
    assert.match(structurePrompt, /subheading/i);
    assert.match(structurePrompt, /nest bullets/i);
    assert.match(structurePrompt, /breadth/i);
    assert.match(structurePrompt, /NOT an interactive canvas/i);
  } finally {
    index.close();
  }
});
