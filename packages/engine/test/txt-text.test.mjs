// Plain UTF-8 .txt for agentic Ask: indexed like a note, cited by heading,
// and skipped when the bytes are not UTF-8.

import assert from "node:assert/strict";
import { mkdtemp, cp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "txt");
const TXT_FACT = "The field code is COPPER FINCH, 312 under Section B.";
const UNCOVERED = "Your notes don't cover this.";

let decodeUtf8Text;
let INVALID_UTF8_MESSAGE;
let discoverMarkdownFiles;
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
  decodeUtf8Text = engine.decodeUtf8Text;
  INVALID_UTF8_MESSAGE = engine.INVALID_UTF8_MESSAGE;
  discoverMarkdownFiles = engine.discoverMarkdownFiles;
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
  const root = await mkdtemp(join(tmpdir(), "cairn-txt-"));
  for (const name of names) await cp(join(fixtures, name), join(root, name));
  return root;
}

test("decodeUtf8Text keeps text and rejects junk", () => {
  assert.equal(decodeUtf8Text(Buffer.from("café Section B")), "café Section B");
  assert.equal(decodeUtf8Text(Buffer.from([0xff, 0xfe, 0x00, 0x80])), null);
  assert.equal(decodeUtf8Text(Buffer.from([0x00])), null);
  assert.equal(INVALID_UTF8_MESSAGE.includes("UTF-8"), true);
});

test("a UTF-8 txt is indexed under its heading and junk is skipped", async () => {
  const root = await vaultWith(["section-b.txt", "project-heron.md", "junk.txt"]);
  try {
    const names = discoverIndexableFiles(root).map((abs) => basename(abs));
    assert.ok(names.includes("section-b.txt"));
    assert.ok(names.includes("project-heron.md"));
    assert.equal(names.includes("junk.txt"), false);
    const markdown = discoverMarkdownFiles(root).map((abs) => basename(abs));
    assert.deepEqual(markdown, ["project-heron.md"]);

    const stats = await indexVault(root, { lexical: true });
    assert.equal(stats.files, 2);
    assert.ok(stats.chunks >= 2);
    const index = openIndex(root);
    try {
      const files = index.listFiles();
      assert.ok(files.includes("section-b.txt"));
      assert.ok(files.includes("project-heron.md"));
      assert.equal(files.includes("junk.txt"), false);

      const state = { sources: [], opened: [] };
      const raw = await runAskSearchTool("grep", { pattern: "COPPER FINCH" }, { index, readNote: async () => "" }, state);
      const parsed = JSON.parse(raw);
      const txt = parsed.matches.find((match) => match.file === "section-b.txt");
      const note = parsed.matches.find((match) => match.file === "project-heron.md");
      assert.ok(txt);
      assert.equal(txt.heading, "Section B");
      assert.match(txt.snippet, /312/);
      assert.ok(note);
      assert.equal(note.heading, "Project Heron");
      assert.equal(parsed.matches.some((match) => match.file === "junk.txt"), false);

      const { hits } = await search(index, "312", { mode: "lexical" });
      assert.equal(hits.length >= 1, true);
      assert.equal(hits.every((hit) => hit.file === "section-b.txt"), true);

      const listed = JSON.parse(
        await runAskSearchTool("list", {}, { index, readNote: async () => "" }, { sources: [], opened: [] }),
      );
      assert.ok(listed.paths.includes("section-b.txt"));
      assert.ok(listed.paths.includes("project-heron.md"));
      assert.equal(listed.paths.includes("junk.txt"), false);
    } finally {
      index.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read returns the txt fact and refuses junk with no source", async () => {
  const section = await readFile(join(fixtures, "section-b.txt"));
  const index = new InMemoryIndex();
  try {
    const readNote = async (path) => {
      if (path === "section-b.txt") {
        const text = decodeUtf8Text(section);
        if (text === null) throw new Error(INVALID_UTF8_MESSAGE);
        return text;
      }
      if (path === "junk.txt") throw new Error(INVALID_UTF8_MESSAGE);
      throw new Error(`missing ${path}`);
    };
    const good = { sources: [], opened: [] };
    const body = await runAskSearchTool("read", { path: "section-b.txt" }, { index, readNote }, good);
    assert.match(body, /COPPER FINCH, 312/);
    assert.equal(good.sources.length, 1);
    assert.equal(good.sources[0].file, "section-b.txt");
    assert.equal(good.sources[0].arms, "read");
    assert.match(good.sources[0].text, /COPPER FINCH, 312 under Section B/);

    const bad = { sources: [], opened: [] };
    const message = await runAskSearchTool("read", { path: "junk.txt" }, { index, readNote }, bad);
    assert.equal(message, `ERROR: ${INVALID_UTF8_MESSAGE}`);
    assert.deepEqual(bad.sources, []);
    assert.equal(bad.unreadableText, true);
  } finally {
    index.close();
  }
});

test("an invented answer after an unreadable txt is refused and has no chip source", async () => {
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async (_model, _messages, _tools, turn) => {
        if (turn === 1) {
          return { content: "", toolCalls: [{ name: "read", arguments: { path: "junk.txt" } }] };
        }
        return { content: TXT_FACT, toolCalls: [] };
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    const result = await runAskAgent({
      index,
      question: "What is the field code?",
      mode: "lexical",
      readNote: async () => {
        throw new Error(INVALID_UTF8_MESSAGE);
      },
      retrievalSeed: false,
    });
    assert.equal(result.answer, UNCOVERED);
    assert.equal(result.answer.includes("COPPER FINCH"), false);
    assert.deepEqual(result.sources, []);
    assert.equal(result.grounded, false);
  } finally {
    index.close();
  }
});
