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

test("briefing template generates a Briefing note whose path uses the Briefing stem and carries a Sources block", async () => {
  // Capture the system prompt the pipeline hands the model so we can assert the
  // template's structure guidance actually reached it.
  let capturedSystem;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chat: async (_model, messages) => {
        capturedSystem = messages.find((m) => m.role === "system")?.content ?? "";
        return [
          "## Context",
          "",
          "Spaced repetition spaces reviews to fight forgetting [1].",
          "",
          "## Key points",
          "",
          "- Reviews at increasing intervals improve retention [1].",
          "",
          "## Implications",
          "",
          "Scheduling reviews deliberately reduces forgetting [1].",
          "",
          "## Open questions",
          "",
          "- What interval schedule is optimal?",
        ].join("\n");
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const result = await generateStudioNote({
      index,
      templateId: "briefing",
      topic: "spaced repetition",
      mode: "lexical",
    });

    assert.equal(result.grounded, true);
    assert.equal(result.covered, true);
    assert.equal(result.template, "briefing");
    assert.ok(result.note, "a note is proposed");

    // Path uses the Briefing filenameStem.
    assert.match(result.note.path, /^Briefing - spaced repetition\.md$/);

    // Heading + structure from the model body.
    assert.match(result.note.content, /^# Briefing: spaced repetition/);
    assert.match(result.note.content, /## Context/);
    assert.match(result.note.content, /## Key points/);
    assert.match(result.note.content, /## Implications/);
    assert.match(result.note.content, /## Open questions/);

    // Citation spine: deterministic Sources block linking back to the real hit.
    assert.match(result.note.content, /## Sources/);
    assert.match(result.note.content, /\[\[notes\/spacing\.md\]\]/);
    assert.ok(result.sources.length > 0);
    assert.equal(result.sources[0].file, "notes/spacing.md");

    // The template's structure guidance reached the model prompt.
    const structure = getStudioTemplate("briefing").prompt.structure;
    assert.ok(capturedSystem.includes(structure), "briefing structure guidance is in the system prompt");
    assert.match(capturedSystem, /BRIEFING/);
    assert.match(capturedSystem, /## Open questions/);
  } finally {
    index.close();
  }
});
