// Vault images are indexed by path only. Ask must not invent what they say or show.

import assert from "node:assert/strict";
import { mkdtemp, cp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "images");
const UNCOVERED = "Your notes don't cover this.";
const HERON = "The notebook codename is COPPER FINCH and the badge is 999.";
const IMAGES = ["section-b.png", "field.jpg", "field.jpeg", "mark.webp", "badge.gif"];

let IMAGE_NO_TEXT;
let isImagePath;
let discoverIndexableFiles;
let indexVault;
let openIndex;
let runAskAgent;
let runAskSearchTool;
let search;
let setModelProvider;
let resetModelProvider;
let FakeModelProvider;
let InMemoryIndex;

before(async () => {
  const engine = await import("../dist/index.js");
  const testing = await import("../dist/testing.js");
  IMAGE_NO_TEXT = engine.IMAGE_NO_TEXT;
  isImagePath = engine.isImagePath;
  discoverIndexableFiles = engine.discoverIndexableFiles;
  indexVault = engine.indexVault;
  openIndex = engine.openIndex;
  runAskAgent = engine.runAskAgent;
  runAskSearchTool = engine.runAskSearchTool;
  search = engine.search;
  setModelProvider = engine.setModelProvider;
  resetModelProvider = engine.resetModelProvider;
  FakeModelProvider = testing.FakeModelProvider;
  InMemoryIndex = testing.InMemoryIndex;
});

after(() => resetModelProvider());

async function vaultWith(names) {
  const root = await mkdtemp(join(tmpdir(), "cairn-image-"));
  for (const name of names) await cp(join(fixtures, name), join(root, name));
  return root;
}

function seedHeron(index, text) {
  index.rebuildIndex({
    mode: "lexical",
    files: 1,
    chunks: [
      {
        id: 1,
        file: "project-heron.md",
        ordinal: 0,
        line: 1,
        heading: "Project Heron",
        text,
        hash: "project-heron",
      },
    ],
  });
}

function neighborWouldAnswer(text) {
  return new FakeModelProvider({
    models: ["qwen3:4b"],
    chatWithTools: async (_model, _messages, _tools, turn) => {
      if (turn === 1) {
        return {
          content: "",
          toolCalls: [
            { name: "read", arguments: { path: "project-heron.md" } },
            { name: "open", arguments: { path: "project-heron.md", line: 1, heading: "Project Heron" } },
          ],
        };
      }
      return { content: text, toolCalls: [] };
    },
  });
}

test("isImagePath accepts the five image extensions and rejects video and audio", () => {
  assert.equal(isImagePath("notes/section-b.png"), true);
  assert.equal(isImagePath("notes/field.JPG"), true);
  assert.equal(isImagePath("notes/field.jpeg"), true);
  assert.equal(isImagePath("notes/mark.webp"), true);
  assert.equal(isImagePath("notes/badge.GIF"), true);
  assert.equal(isImagePath("notes/clip.mp4"), false);
  assert.equal(isImagePath("notes/tone.mp3"), false);
  assert.equal(isImagePath("notes/project-heron.md"), false);
  assert.equal(IMAGE_NO_TEXT.includes("image"), true);
});

test("images are indexed by path only, with no text body and no embeddings", async () => {
  const root = await vaultWith([...IMAGES, "project-heron.md"]);
  await writeFile(join(root, "clip.mp4"), Buffer.from("not video"));
  await writeFile(join(root, "tone.mp3"), Buffer.from("not audio"));
  try {
    const names = discoverIndexableFiles(root).map((abs) => basename(abs));
    for (const image of IMAGES) assert.ok(names.includes(image), image);
    assert.ok(names.includes("project-heron.md"));
    assert.equal(names.includes("clip.mp4"), false);
    assert.equal(names.includes("tone.mp3"), false);

    const stats = await indexVault(root, { lexical: true });
    assert.equal(stats.files, IMAGES.length + 1);
    assert.equal(stats.embedded, 0);
    assert.ok(stats.chunks >= 1);

    const index = openIndex(root);
    try {
      const files = index.listFiles();
      assert.deepEqual(files, ["project-heron.md"]);
      for (const image of IMAGES) assert.equal(files.includes(image), false);

      const { hits } = await search(index, "COPPER FINCH", { mode: "lexical" });
      assert.ok(hits.length >= 1);
      assert.equal(hits.every((hit) => hit.file === "project-heron.md"), true);

      const binary = await search(index, "IHDR", { mode: "lexical" });
      assert.deepEqual(binary.hits, []);

      const fromIndex = JSON.parse(
        await runAskSearchTool("list", {}, { index, readNote: async () => "" }, { sources: [], opened: [] }),
      );
      assert.deepEqual(fromIndex.paths, ["project-heron.md"]);

      const fromVault = JSON.parse(
        await runAskSearchTool(
          "list",
          {},
          {
            index,
            readNote: async () => "",
            listNotes: async () => [...IMAGES, "project-heron.md", "clip.mp4", "tone.mp3"],
          },
          { sources: [], opened: [] },
        ),
      );
      for (const image of IMAGES) assert.ok(fromVault.paths.includes(image), image);
      assert.equal(fromVault.paths.includes("clip.mp4"), false);
      assert.equal(fromVault.paths.includes("tone.mp3"), false);
    } finally {
      index.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an image-only vault indexes paths and does not embed", async () => {
  const root = await vaultWith(IMAGES);
  try {
    const stats = await indexVault(root);
    assert.equal(stats.files, IMAGES.length);
    assert.equal(stats.chunks, 0);
    assert.equal(stats.embedded, 0);
    const index = openIndex(root);
    try {
      assert.deepEqual(index.listFiles(), []);
    } finally {
      index.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read and open refuse an image and record no source", async () => {
  const png = await readFile(join(fixtures, "section-b.png"));
  const index = new InMemoryIndex();
  try {
    const readNote = async (path) => {
      if (path === "section-b.png") {
        assert.ok(png.length > 8);
        throw new Error(IMAGE_NO_TEXT);
      }
      throw new Error(`missing ${path}`);
    };
    const readState = { sources: [], opened: [] };
    const readMessage = await runAskSearchTool("read", { path: "section-b.png" }, { index, readNote }, readState);
    assert.equal(readMessage, `ERROR: ${IMAGE_NO_TEXT}`);
    assert.deepEqual(readState.sources, []);
    assert.deepEqual(readState.opened, []);
    assert.equal(readState.textlessImage, true);

    const openState = { sources: [], opened: [] };
    const openMessage = await runAskSearchTool(
      "open",
      { path: "section-b.png" },
      { index, readNote },
      openState,
    );
    assert.equal(openMessage, `ERROR: ${IMAGE_NO_TEXT}`);
    assert.deepEqual(openState.opened, []);
    assert.equal(openState.textlessImage, true);

    const missing = { sources: [], opened: [] };
    const missingMessage = await runAskSearchTool(
      "read",
      { path: "gone.png" },
      { index, readNote: async () => { throw new Error("missing gone.png"); } },
      missing,
    );
    assert.equal(missingMessage, "ERROR: missing gone.png");
    assert.equal(missing.textlessImage, undefined);
  } finally {
    index.close();
  }
});

test('QA: "What does section-b.png show?" is an honest miss with zero chips', async () => {
  const note = await readFile(join(fixtures, "project-heron.md"), "utf8");
  const index = new InMemoryIndex();
  seedHeron(index, note);
  let calls = 0;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async (_model, _messages, _tools, turn) => {
        calls += 1;
        if (turn === 1) {
          return { content: "", toolCalls: [{ name: "read", arguments: { path: "project-heron.md" } }] };
        }
        return { content: note, toolCalls: [] };
      },
    }),
  );
  try {
    const result = await runAskAgent({
      index,
      question: "What does section-b.png show?",
      mode: "lexical",
      readNote: async (path) => {
        if (path === "section-b.png") throw new Error(IMAGE_NO_TEXT);
        if (path === "project-heron.md") return note;
        throw new Error(`missing ${path}`);
      },
      retrievalSeed: false,
    });
    assert.equal(calls, 0);
    assert.equal(result.answer, UNCOVERED);
    assert.equal(result.answer.includes("COPPER FINCH"), false);
    assert.deepEqual(result.sources, []);
    assert.deepEqual(result.opened, []);
    assert.equal(result.grounded, false);
    assert.equal(result.stopReason, "done");
  } finally {
    resetModelProvider();
    index.close();
  }
});

test("a named image does not cite a neighbor that only shares the codename", async () => {
  const note = await readFile(join(fixtures, "project-heron.md"), "utf8");
  const index = new InMemoryIndex();
  seedHeron(index, note);
  let calls = 0;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async () => {
        calls += 1;
        return { content: HERON, toolCalls: [] };
      },
    }),
  );
  try {
    const result = await runAskAgent({
      index,
      question: "What does section-b.png say about Project Heron?",
      mode: "lexical",
      readNote: async (path) => {
        if (isImagePath(path)) throw new Error(IMAGE_NO_TEXT);
        if (path === "project-heron.md") return note;
        throw new Error(`missing ${path}`);
      },
      retrievalSeed: false,
    });
    assert.equal(calls, 0);
    assert.equal(result.answer, UNCOVERED);
    assert.equal(result.answer.includes("COPPER FINCH"), false);
    assert.equal(result.answer.includes("999"), false);
    assert.deepEqual(result.sources, []);
    assert.deepEqual(result.opened, []);
  } finally {
    resetModelProvider();
    index.close();
  }
});

test("returned image bytes are still an honest miss", async () => {
  const note = await readFile(join(fixtures, "project-heron.md"), "utf8");
  const png = await readFile(join(fixtures, "section-b.png"));
  const index = new InMemoryIndex();
  seedHeron(index, note);
  let calls = 0;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async (_model, _messages, _tools, turn) => {
        calls += 1;
        if (turn === 1) {
          return { content: "", toolCalls: [{ name: "read", arguments: { path: "project-heron.md" } }] };
        }
        return { content: note, toolCalls: [] };
      },
    }),
  );
  try {
    const result = await runAskAgent({
      index,
      question: "What does section-b.PNG say?",
      mode: "lexical",
      readNote: async (path) => {
        if (path.toLowerCase() === "section-b.png") return png.toString("utf8");
        if (path === "project-heron.md") return note;
        throw new Error(`missing ${path}`);
      },
      retrievalSeed: false,
    });
    assert.equal(calls, 0);
    assert.equal(result.answer, UNCOVERED);
    assert.equal(result.answer.includes("IHDR"), false);
    assert.deepEqual(result.sources, []);
    assert.deepEqual(result.opened, []);
  } finally {
    resetModelProvider();
    index.close();
  }
});

test("a question that does not name an image still answers from the note", async () => {
  const note = await readFile(join(fixtures, "project-heron.md"), "utf8");
  const index = new InMemoryIndex();
  seedHeron(index, note);
  setModelProvider(neighborWouldAnswer(note));
  try {
    const result = await runAskAgent({
      index,
      question: "What is the notebook codename?",
      mode: "lexical",
      readNote: async (path) => {
        if (path === "section-b.png") throw new Error(IMAGE_NO_TEXT);
        if (path === "project-heron.md") return note;
        throw new Error(`missing ${path}`);
      },
      retrievalSeed: false,
    });
    assert.equal(result.answer.includes("COPPER FINCH"), true);
    assert.equal(result.sources.some((source) => source.file === "project-heron.md"), true);
    assert.equal(result.sources.some((source) => isImagePath(source.file)), false);
    assert.equal(result.opened.some((anchor) => isImagePath(anchor.path)), false);
  } finally {
    resetModelProvider();
    index.close();
  }
});

test("a named image that is not in the vault is not an honest miss", async () => {
  const note = await readFile(join(fixtures, "project-heron.md"), "utf8");
  const index = new InMemoryIndex();
  seedHeron(index, note);
  setModelProvider(neighborWouldAnswer(note));
  try {
    const result = await runAskAgent({
      index,
      question: "What does missing.png say?",
      mode: "lexical",
      readNote: async (path) => {
        if (path === "project-heron.md") return note;
        throw new Error(`missing ${path}`);
      },
      retrievalSeed: false,
    });
    assert.equal(result.answer.includes("COPPER FINCH"), true);
    assert.notEqual(result.answer, UNCOVERED);
    assert.equal(result.sources.some((source) => source.file === "project-heron.md"), true);
  } finally {
    resetModelProvider();
    index.close();
  }
});
