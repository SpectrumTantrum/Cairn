import assert from "node:assert/strict";
import { after, before, test } from "node:test";

let generateStudioNote;
let getStudioTemplate;
let setModelProvider;
let resetModelProvider;
let FakeModelProvider;
let InMemoryIndex;

// The prompt actually handed to the chat model — captured so we can assert the Quiz template
// injects its quiz + answer-key structure guidance into the shared grounding preamble.
let capturedSystem;

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

test("the quiz template is enabled and carries a Quiz prompt scaffold", () => {
  const quiz = getStudioTemplate("quiz");
  assert.ok(quiz, "quiz template is registered");
  assert.equal(quiz.enabled, true);
  assert.ok(quiz.prompt, "enabled quiz template carries a prompt scaffold");
  assert.equal(quiz.prompt.filenameStem, "Quiz");
});

test("generateStudioNote('quiz') produces a cited quiz note with a Quiz filename stem", async () => {
  capturedSystem = undefined;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chat: async (_model, messages) => {
        capturedSystem = messages.find((m) => m.role === "system")?.content ?? "";
        return [
          "## Questions",
          "",
          "1. What does spaced repetition do to review intervals?",
          "   - A. Shortens them",
          "   - B. Increases them over time",
          "   - C. Randomises them",
          "   - D. Removes them",
          "2. Short answer: what problem does spaced repetition fight?",
          "",
          "## Answer Key",
          "",
          "1. B — reviews are scheduled at increasing intervals [1].",
          "2. Forgetting [1].",
        ].join("\n");
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const result = await generateStudioNote({
      index,
      templateId: "quiz",
      topic: "spaced repetition",
      mode: "lexical",
    });

    assert.equal(result.grounded, true);
    assert.equal(result.covered, true);
    assert.equal(result.template, "quiz");
    assert.ok(result.note, "a note is proposed");
    // Filename stem is "Quiz".
    assert.match(result.note.path, /^Quiz - spaced repetition\.md$/);

    // Structure (from the model body): quiz + separated answer key.
    assert.match(result.note.content, /^# Quiz: spaced repetition/);
    assert.match(result.note.content, /## Questions/);
    assert.match(result.note.content, /## Answer Key/);

    // Citation spine: inline citation AND a deterministic Sources block from the real hit.
    assert.match(result.note.content, /\[1\]/);
    assert.match(result.note.content, /## Sources/);
    assert.match(result.note.content, /\[\[notes\/spacing\.md\]\]/);
    assert.ok(result.sources.length > 0, "sources come from real retrieval hits");
    assert.equal(result.sources[0].file, "notes/spacing.md");
  } finally {
    index.close();
  }
});

test("the Quiz prompt instructs a quiz + cited answer key answerable from sources alone", async () => {
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chat: async (_model, messages) => {
        capturedSystem = messages.find((m) => m.role === "system")?.content ?? "";
        return "## Questions\n\n1. Placeholder?\n\n## Answer Key\n\n1. Placeholder [1].\n";
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    await generateStudioNote({
      index,
      templateId: "quiz",
      topic: "spaced repetition",
      mode: "lexical",
    });

    assert.ok(capturedSystem, "the system prompt was captured");
    // The Quiz structure guidance is present in the prompt.
    assert.match(capturedSystem, /QUIZ/);
    assert.match(capturedSystem, /## Questions/);
    assert.match(capturedSystem, /## Answer Key/);
    // Multiple-choice with 4 options and exactly one correct.
    assert.match(capturedSystem, /multiple-choice/i);
    assert.match(capturedSystem, /4 options/i);
    assert.match(capturedSystem, /short-answer/i);
    // Answerable from the sources alone — no outside knowledge.
    assert.match(capturedSystem, /answerable from the sources alone/i);
    // The answer key must carry citations; the model must not write its own Sources list.
    assert.match(capturedSystem, /cite the source/i);
    assert.match(capturedSystem, /Do NOT write your own Sources list/);
  } finally {
    index.close();
  }
});
