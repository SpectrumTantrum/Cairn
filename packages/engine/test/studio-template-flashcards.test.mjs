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

test("Flashcards template is enabled and carries a Flashcards filename stem + Q/A-format guidance", () => {
  const template = getStudioTemplate("flashcards");
  assert.ok(template, "flashcards template is registered");
  assert.equal(template.enabled, true);
  assert.ok(template.prompt, "enabled flashcards template carries a prompt scaffold");
  assert.equal(template.prompt.filenameStem, "Flashcards");
  // The scaffold must ask for the machine-recognizable **Q:**/**A:** card format.
  assert.match(template.prompt.structure, /\*\*Q:\*\*/);
  assert.match(template.prompt.structure, /\*\*A:\*\*/);
  assert.match(template.prompt.structure, /blank line between cards/i);
  assert.match(template.prompt.structure, /atomic fact per card/i);
  // Citation guidance mirrors Study Guide: answers are cited, Sources is appended for us.
  assert.match(template.prompt.structure, /cite/i);
  assert.match(template.prompt.structure, /Do NOT write your own Sources list/);
});

test("generateStudioNote(flashcards) returns a Flashcards note with a Sources block from real hits", async () => {
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chat: async () =>
        [
          "**Q:** What is spaced repetition?",
          "**A:** A schedule that reviews material at increasing intervals to fight forgetting [1].",
          "",
          "**Q:** Why does spacing improve retention?",
          "**A:** Increasing intervals force effortful recall, which strengthens memory [1].",
        ].join("\n"),
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const result = await generateStudioNote({
      index,
      templateId: "flashcards",
      topic: "spaced repetition",
      mode: "lexical",
    });

    assert.equal(result.grounded, true);
    assert.equal(result.covered, true);
    assert.equal(result.template, "flashcards");
    assert.ok(result.note, "a note is proposed");
    // Filename stem drives the proposed path.
    assert.match(result.note.path, /^Flashcards - spaced repetition\.md$/);
    assert.match(result.note.content, /^# Flashcards: spaced repetition/);

    // The Q/A card format survives into the note body.
    assert.match(result.note.content, /\*\*Q:\*\* What is spaced repetition\?/);
    assert.match(result.note.content, /\*\*A:\*\*/);

    // Citation spine: an inline citation AND a deterministic Sources block built from the
    // real retrieved hit — provenance never depends on the model.
    assert.match(result.note.content, /\[1\]/);
    assert.match(result.note.content, /## Sources/);
    assert.match(result.note.content, /\[\[notes\/spacing\.md\]\]/);
    assert.ok(result.sources.length > 0);
    assert.equal(result.sources[0].file, "notes/spacing.md");
  } finally {
    index.close();
  }
});
