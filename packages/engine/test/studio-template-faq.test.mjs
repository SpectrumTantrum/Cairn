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

test("the faq template is enabled and carries an FAQ prompt scaffold", () => {
  const faq = getStudioTemplate("faq");
  assert.ok(faq, "faq template is registered");
  assert.equal(faq.enabled, true);
  assert.ok(faq.prompt, "enabled faq template carries a prompt scaffold");
  assert.equal(faq.prompt.filenameStem, "FAQ");
});

test("generateStudioNote(faq) produces a cited FAQ note and shows FAQ structure guidance in the model prompt", async () => {
  let capturedSystem = "";
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chat: async (_model, messages) => {
        capturedSystem = messages.find((m) => m.role === "system")?.content ?? "";
        return [
          "### What is spaced repetition?",
          "",
          "It schedules reviews at increasing intervals to fight forgetting [1].",
          "",
          "### Why do increasing intervals help?",
          "",
          "Widening the gaps forces harder recall, which strengthens retention [1].",
        ].join("\n");
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const result = await generateStudioNote({
      index,
      templateId: "faq",
      topic: "spaced repetition",
      mode: "lexical",
    });

    assert.equal(result.grounded, true);
    assert.equal(result.covered, true);
    assert.equal(result.template, "faq");

    // Note uses the FAQ filenameStem.
    assert.ok(result.note, "a note is proposed");
    assert.match(result.note.path, /^FAQ - spaced repetition\.md$/);
    assert.match(result.note.content, /^# FAQ: spaced repetition/);

    // Q&A body from the model, with an inline citation.
    assert.match(result.note.content, /### What is spaced repetition\?/);
    assert.match(result.note.content, /\[1\]/);

    // Deterministic Sources block linking back to the real retrieved hit.
    assert.match(result.note.content, /## Sources/);
    assert.match(result.note.content, /\[\[notes\/spacing\.md\]\]/);
    assert.ok(result.sources.length > 0);
    assert.equal(result.sources[0].file, "notes/spacing.md");

    // The FAQ-specific structure guidance reached the model prompt.
    assert.match(capturedSystem, /question-and-answer pairs/);
    assert.match(capturedSystem, /fundamental question to the most advanced/);
    assert.match(capturedSystem, /do not invent one/);
  } finally {
    index.close();
  }
});
