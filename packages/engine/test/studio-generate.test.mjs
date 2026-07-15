import assert from "node:assert/strict";
import { after, before, test } from "node:test";

let generateStudioNote;
let STUDIO_TEMPLATES;
let getStudioTemplate;
let studioTemplateMetas;
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
  STUDIO_TEMPLATES = engine.STUDIO_TEMPLATES;
  getStudioTemplate = engine.getStudioTemplate;
  studioTemplateMetas = engine.studioTemplateMetas;
  setModelProvider = engine.setModelProvider;
  resetModelProvider = engine.resetModelProvider;
  FakeModelProvider = testing.FakeModelProvider;
  InMemoryIndex = testing.InMemoryIndex;
});

after(() => resetModelProvider());

test("registry ships seven templates with exactly one enabled (Study Guide)", () => {
  assert.equal(STUDIO_TEMPLATES.length, 7);
  const enabled = STUDIO_TEMPLATES.filter((t) => t.enabled);
  assert.equal(enabled.length, 1);
  assert.equal(enabled[0].id, "study-guide");
  assert.ok(enabled[0].prompt, "the enabled template carries a prompt scaffold");
  assert.ok(enabled[0].prompt.filenameStem);
  // Every disabled template still carries card metadata so the desktop can render it.
  for (const t of STUDIO_TEMPLATES.filter((x) => !x.enabled)) {
    assert.ok(t.title && t.description && t.icon && t.needs, `${t.id} has card metadata`);
    assert.equal(t.prompt, undefined, `${t.id} ships no prompt yet`);
  }
  assert.ok(getStudioTemplate("study-guide"));
  assert.equal(getStudioTemplate("does-not-exist"), undefined);
});

test("studioTemplateMetas exposes renderer-safe metadata without the prompt scaffold", () => {
  const metas = studioTemplateMetas();
  assert.equal(metas.length, 7);
  for (const m of metas) {
    assert.equal("prompt" in m, false, "prompt scaffolds never cross the IPC boundary");
    assert.ok(m.id && m.title && m.icon);
  }
});

test("generateStudioNote returns a structured note that carries citations back to its sources", async () => {
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chat: async () =>
        [
          "## Overview",
          "",
          "Spaced repetition fights forgetting by spacing reviews [1].",
          "",
          "## Key concepts",
          "",
          "- Spacing effect — reviews at increasing intervals improve retention [1].",
          "",
          "## Self-check questions",
          "",
          "1. What is spaced repetition?",
        ].join("\n"),
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const result = await generateStudioNote({
      index,
      templateId: "study-guide",
      topic: "spaced repetition",
      mode: "lexical",
    });

    assert.equal(result.grounded, true);
    assert.equal(result.covered, true);
    assert.equal(result.template, "study-guide");
    assert.ok(result.note, "a note is proposed");
    assert.match(result.note.path, /^Study Guide - spaced repetition\.md$/);

    // Structure (from the model body).
    assert.match(result.note.content, /^# Study Guide: spaced repetition/);
    assert.match(result.note.content, /## Overview/);
    assert.match(result.note.content, /## Key concepts/);
    assert.match(result.note.content, /## Self-check questions/);

    // Citation spine: an inline citation AND a deterministic Sources section linking back to
    // the retrieved file — provenance is present even if the model omits it.
    assert.match(result.note.content, /\[1\]/);
    assert.match(result.note.content, /## Sources/);
    assert.match(result.note.content, /\[\[notes\/spacing\.md\]\]/);
    assert.ok(result.sources.length > 0);
    assert.equal(result.sources[0].file, "notes/spacing.md");
  } finally {
    index.close();
  }
});

test("generateStudioNote appends a Sources section even when the model omits citations", async () => {
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      // A model that forgets to cite anything — provenance must still be enforced.
      chat: async () => "## Overview\n\nA study guide with no citations at all.\n",
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const result = await generateStudioNote({
      index,
      templateId: "study-guide",
      topic: "spaced repetition",
      mode: "lexical",
    });
    assert.ok(result.note);
    assert.match(result.note.content, /## Sources/);
    assert.match(result.note.content, /\[\[notes\/spacing\.md\]\]/);
  } finally {
    index.close();
  }
});

test("generateStudioNote refuses (no note) when retrieval does not cover the topic", async () => {
  let chatCalls = 0;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chat: async () => {
        chatCalls++;
        return "should never run";
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    seed(index);
    const result = await generateStudioNote({
      index,
      templateId: "study-guide",
      topic: "quantum chromodynamics tax law",
      mode: "lexical",
    });
    assert.equal(result.covered, false);
    assert.equal(result.grounded, false);
    assert.equal(result.note, null);
    assert.match(result.answer, /don't cover/i);
    assert.equal(chatCalls, 0, "no generation is attempted without covered retrieval");
  } finally {
    index.close();
  }
});

test("an unknown or not-yet-enabled template id is refused before any model call", async () => {
  const index = new InMemoryIndex();
  try {
    seed(index);
    await assert.rejects(
      () => generateStudioNote({ index, templateId: "nope", topic: "x", mode: "lexical" }),
      /Unknown Studio template/,
    );
    await assert.rejects(
      () => generateStudioNote({ index, templateId: "quiz", topic: "x", mode: "lexical" }),
      /not available yet/,
    );
  } finally {
    index.close();
  }
});
