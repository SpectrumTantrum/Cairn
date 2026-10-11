// Vault audio is indexed by path only. Ask must not invent a transcript.

import assert from "node:assert/strict";
import { mkdtemp, cp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "audio");
const UNCOVERED = "Your notes don't cover this.";
const HERON = "The notebook codename is COPPER FINCH and the badge is 999.";
const AUDIO = ["section-b.mp3", "tone.wav", "clip.m4a"];

let AUDIO_NO_TEXT;
let isAudioPath;
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
  AUDIO_NO_TEXT = engine.AUDIO_NO_TEXT;
  isAudioPath = engine.isAudioPath;
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
  const root = await mkdtemp(join(tmpdir(), "cairn-audio-"));
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

test("isAudioPath accepts mp3, wav, and m4a and rejects video and images", () => {
  assert.equal(isAudioPath("notes/section-b.mp3"), true);
  assert.equal(isAudioPath("notes/tone.WAV"), true);
  assert.equal(isAudioPath("notes/clip.m4a"), true);
  assert.equal(isAudioPath("notes/clip.mp4"), false);
  assert.equal(isAudioPath("notes/section-b.png"), false);
  assert.equal(isAudioPath("notes/project-heron.md"), false);
  assert.equal(AUDIO_NO_TEXT.includes("audio"), true);
});

test("audio is indexed by path only, with no text body and no embeddings", async () => {
  const root = await vaultWith([...AUDIO, "project-heron.md"]);
  await writeFile(join(root, "clip.mkv"), Buffer.from("not video"));
  try {
    const names = discoverIndexableFiles(root).map((abs) => basename(abs));
    for (const file of AUDIO) assert.ok(names.includes(file), file);
    assert.ok(names.includes("project-heron.md"));
    assert.equal(names.includes("clip.mkv"), false);

    const stats = await indexVault(root, { lexical: true });
    assert.equal(stats.files, AUDIO.length + 1);
    assert.equal(stats.embedded, 0);
    assert.ok(stats.chunks >= 1);

    const index = openIndex(root);
    try {
      const files = index.listFiles();
      assert.deepEqual(files, ["project-heron.md"]);
      for (const file of AUDIO) assert.equal(files.includes(file), false);

      const { hits } = await search(index, "COPPER FINCH", { mode: "lexical" });
      assert.ok(hits.length >= 1);
      assert.equal(hits.every((hit) => hit.file === "project-heron.md"), true);

      const id3 = await search(index, "ID3", { mode: "lexical" });
      assert.deepEqual(id3.hits, []);

      const fromVault = JSON.parse(
        await runAskSearchTool(
          "list",
          {},
          {
            index,
            readNote: async () => "",
            listNotes: async () => [...AUDIO, "project-heron.md", "clip.mkv"],
          },
          { sources: [], opened: [] },
        ),
      );
      for (const file of AUDIO) assert.ok(fromVault.paths.includes(file), file);
      assert.equal(fromVault.paths.includes("clip.mkv"), false);
    } finally {
      index.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an audio-only vault indexes paths and does not embed", async () => {
  const root = await vaultWith(AUDIO);
  try {
    const stats = await indexVault(root);
    assert.equal(stats.files, AUDIO.length);
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

test("read and open refuse audio and record no source", async () => {
  const mp3 = await readFile(join(fixtures, "section-b.mp3"));
  const index = new InMemoryIndex();
  try {
    const readNote = async (path) => {
      if (path === "section-b.mp3") {
        assert.ok(mp3.length > 8);
        throw new Error(AUDIO_NO_TEXT);
      }
      throw new Error(`missing ${path}`);
    };
    const readState = { sources: [], opened: [] };
    const readMessage = await runAskSearchTool("read", { path: "section-b.mp3" }, { index, readNote }, readState);
    assert.equal(readMessage, `ERROR: ${AUDIO_NO_TEXT}`);
    assert.deepEqual(readState.sources, []);
    assert.deepEqual(readState.opened, []);
    assert.equal(readState.textlessAudio, true);

    const openState = { sources: [], opened: [] };
    const openMessage = await runAskSearchTool("open", { path: "section-b.mp3" }, { index, readNote }, openState);
    assert.equal(openMessage, `ERROR: ${AUDIO_NO_TEXT}`);
    assert.deepEqual(openState.opened, []);
    assert.equal(openState.textlessAudio, true);
  } finally {
    index.close();
  }
});

test('QA: "What does section-b.mp3 say?" is an honest miss with zero chips', async () => {
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
      question: "What does section-b.mp3 say?",
      mode: "lexical",
      readNote: async (path) => {
        if (path === "section-b.mp3") throw new Error(AUDIO_NO_TEXT);
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

test("a named audio file does not cite a neighbor that only shares the codename", async () => {
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
      question: "What does section-b.mp3 say about Project Heron?",
      mode: "lexical",
      readNote: async (path) => {
        if (isAudioPath(path)) throw new Error(AUDIO_NO_TEXT);
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

test("a question that does not name audio still answers from the note", async () => {
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
        if (path === "section-b.mp3") throw new Error(AUDIO_NO_TEXT);
        if (path === "project-heron.md") return note;
        throw new Error(`missing ${path}`);
      },
      retrievalSeed: false,
    });
    assert.equal(result.answer.includes("COPPER FINCH"), true);
    assert.equal(result.sources.some((source) => source.file === "project-heron.md"), true);
    assert.equal(result.sources.some((source) => isAudioPath(source.file)), false);
  } finally {
    resetModelProvider();
    index.close();
  }
});

test("a named audio file that is not in the vault is not an honest miss", async () => {
  const note = await readFile(join(fixtures, "project-heron.md"), "utf8");
  const index = new InMemoryIndex();
  seedHeron(index, note);
  setModelProvider(neighborWouldAnswer(note));
  try {
    const result = await runAskAgent({
      index,
      question: "What does missing.wav say?",
      mode: "lexical",
      readNote: async (path) => {
        if (path === "project-heron.md") return note;
        throw new Error(`missing ${path}`);
      },
      retrievalSeed: false,
    });
    assert.equal(result.answer.includes("COPPER FINCH"), true);
    assert.notEqual(result.answer, UNCOVERED);
  } finally {
    resetModelProvider();
    index.close();
  }
});
