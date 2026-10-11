// HTML for agentic Ask: visible text via node-html-parser, chunked like a note,
// cited by heading, and skipped when extraction yields nothing.

import assert from "node:assert/strict";
import { mkdtemp, cp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "html");
const HTML_FACT = "The field code is COPPER FINCH, 312 under Section B.";
const UNCOVERED = "Your notes don't cover this.";

let extractHtmlText;
let HTML_NO_TEXT;
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
  extractHtmlText = engine.extractHtmlText;
  HTML_NO_TEXT = engine.HTML_NO_TEXT;
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
  const root = await mkdtemp(join(tmpdir(), "cairn-html-"));
  for (const name of names) await cp(join(fixtures, name), join(root, name));
  return root;
}

function sectionBNeighbor(text) {
  return new FakeModelProvider({
    models: ["qwen3:4b"],
    chatWithTools: async (_model, _messages, _tools, turn) => {
      if (turn === 1) {
        return {
          content: "",
          toolCalls: [
            { name: "read", arguments: { path: "section-b.html" } },
            { name: "open", arguments: { path: "section-b.html", line: 1 } },
          ],
        };
      }
      return { content: text, toolCalls: [] };
    },
  });
}

function seedSectionB(index, text) {
  index.rebuildIndex({
    mode: "lexical",
    files: 1,
    chunks: [
      {
        id: 1,
        file: "section-b.html",
        ordinal: 0,
        line: 1,
        heading: "Field report",
        text,
        hash: "section-b-html",
      },
    ],
  });
}

test("extractHtmlText keeps headings and drops scripts, styles, and tags", async () => {
  const raw = await readFile(join(fixtures, "section-b.html"), "utf8");
  const text = extractHtmlText(raw);
  assert.match(text, /^# Field report$/m);
  assert.match(text, /^## Section A$/m);
  assert.match(text, /^## Section B$/m);
  assert.match(text, /COPPER FINCH, 312 under Section B/);
  assert.equal(text.includes("script leak"), false);
  assert.equal(text.includes("DO NOT INDEX"), false);
  assert.equal(text.includes("<"), false);
  assert.equal(extractHtmlText("<p>A &amp; B</p>"), "A & B");
  assert.equal(extractHtmlText('<div hidden>secret</div><p>visible</p>'), "visible");
  assert.equal(extractHtmlText("<h2>Section <em>B</em></h2>"), "## Section B");
  assert.equal(extractHtmlText(await readFile(join(fixtures, "empty.html"), "utf8")), "");
  assert.equal(HTML_NO_TEXT.includes("no readable text"), true);
});

test("a headed html file is indexed and empty or invalid html is skipped", async () => {
  const root = await vaultWith(["section-b.html", "project-heron.md", "empty.html", "junk.html"]);
  await writeFile(join(root, "alias.htm"), "<h2>Alias</h2><p>The htm marker is BLUE JAY.</p>");
  try {
    const names = discoverIndexableFiles(root).map((abs) => basename(abs));
    assert.ok(names.includes("section-b.html"));
    assert.ok(names.includes("project-heron.md"));
    assert.ok(names.includes("empty.html"));
    assert.ok(names.includes("alias.htm"));
    assert.equal(names.includes("junk.html"), false);
    const markdown = discoverMarkdownFiles(root).map((abs) => basename(abs));
    assert.deepEqual(markdown, ["project-heron.md"]);

    const stats = await indexVault(root, { lexical: true });
    assert.equal(stats.files, 4);
    const index = openIndex(root);
    try {
      const files = index.listFiles();
      assert.ok(files.includes("section-b.html"));
      assert.ok(files.includes("project-heron.md"));
      assert.ok(files.includes("alias.htm"));
      assert.equal(files.includes("empty.html"), false);
      assert.equal(files.includes("junk.html"), false);

      const state = { sources: [], opened: [] };
      const raw = await runAskSearchTool("grep", { pattern: "COPPER FINCH" }, { index, readNote: async () => "" }, state);
      const parsed = JSON.parse(raw);
      const html = parsed.matches.find((match) => match.file === "section-b.html");
      const note = parsed.matches.find((match) => match.file === "project-heron.md");
      assert.ok(html);
      assert.equal(html.heading, "Section B");
      assert.match(html.snippet, /312/);
      assert.ok(note);
      assert.equal(note.heading, "Project Heron");
      assert.equal(parsed.matches.some((match) => match.file === "empty.html"), false);
      assert.equal(parsed.matches.some((match) => match.file === "junk.html"), false);

      const { hits } = await search(index, "312", { mode: "lexical" });
      assert.equal(hits.length >= 1, true);
      assert.equal(hits.every((hit) => hit.file === "section-b.html"), true);

      const listed = JSON.parse(
        await runAskSearchTool("list", {}, { index, readNote: async () => "" }, { sources: [], opened: [] }),
      );
      assert.ok(listed.paths.includes("section-b.html"));
      assert.equal(listed.paths.includes("empty.html"), false);
      assert.equal(listed.paths.includes("junk.html"), false);

      const htm = JSON.parse(
        await runAskSearchTool("grep", { pattern: "BLUE JAY" }, { index, readNote: async () => "" }, { sources: [], opened: [] }),
      );
      assert.equal(htm.matches[0].file, "alias.htm");
      assert.equal(htm.matches[0].heading, "Alias");
    } finally {
      index.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read returns the html fact and refuses empty html with no source", async () => {
  const visible = extractHtmlText(await readFile(join(fixtures, "section-b.html"), "utf8"));
  const index = new InMemoryIndex();
  try {
    const readNote = async (path) => {
      if (path === "section-b.html") return visible;
      if (path === "empty.html") throw new Error(HTML_NO_TEXT);
      throw new Error(`missing ${path}`);
    };
    const good = { sources: [], opened: [] };
    const body = await runAskSearchTool("read", { path: "section-b.html" }, { index, readNote }, good);
    assert.match(body, /COPPER FINCH, 312/);
    assert.equal(good.sources.length, 1);
    assert.equal(good.sources[0].file, "section-b.html");
    assert.match(good.sources[0].text, /under Section B/);

    const bad = { sources: [], opened: [] };
    const message = await runAskSearchTool("read", { path: "empty.html" }, { index, readNote }, bad);
    assert.equal(message, `ERROR: ${HTML_NO_TEXT}`);
    assert.deepEqual(bad.sources, []);
    assert.equal(bad.textlessHtml, true);

    const opened = { sources: [], opened: [] };
    const openMessage = await runAskSearchTool("open", { path: "empty.html", line: 1 }, { index, readNote }, opened);
    assert.equal(openMessage, `ERROR: ${HTML_NO_TEXT}`);
    assert.deepEqual(opened.sources, []);
    assert.deepEqual(opened.opened, []);
  } finally {
    index.close();
  }
});

test("an invented answer after an empty html file is refused and has no chip source", async () => {
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async (_model, _messages, _tools, turn) => {
        if (turn === 1) {
          return { content: "", toolCalls: [{ name: "read", arguments: { path: "empty.html" } }] };
        }
        return { content: HTML_FACT, toolCalls: [] };
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
        throw new Error(HTML_NO_TEXT);
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

test('QA: "What does empty.html say?" is an honest miss and does not cite the neighbor', async () => {
  const section = extractHtmlText(await readFile(join(fixtures, "section-b.html"), "utf8"));
  const index = new InMemoryIndex();
  seedSectionB(index, section);
  setModelProvider(sectionBNeighbor(section));
  try {
    const result = await runAskAgent({
      index,
      question: "What does empty.html say?",
      mode: "lexical",
      readNote: async (path) => {
        if (path === "empty.html") throw new Error(HTML_NO_TEXT);
        if (path === "section-b.html") return section;
        throw new Error(`missing ${path}`);
      },
      retrievalSeed: false,
    });
    assert.equal(result.answer, UNCOVERED);
    assert.equal(result.answer.includes("COPPER FINCH"), false);
    assert.equal(result.answer.includes("Field report"), false);
    assert.deepEqual(result.sources, []);
    assert.deepEqual(result.opened, []);
    assert.equal(result.grounded, false);
    assert.equal(result.stopReason, "done");
  } finally {
    resetModelProvider();
    index.close();
  }
});

test('QA: "What does junk.html say?" is an honest miss', async () => {
  const section = extractHtmlText(await readFile(join(fixtures, "section-b.html"), "utf8"));
  const index = new InMemoryIndex();
  seedSectionB(index, section);
  setModelProvider(sectionBNeighbor(section));
  try {
    const result = await runAskAgent({
      index,
      question: "What does junk.html say?",
      mode: "lexical",
      readNote: async (path) => {
        if (path === "junk.html") throw new Error(INVALID_UTF8_MESSAGE);
        if (path === "section-b.html") return section;
        throw new Error(`missing ${path}`);
      },
      retrievalSeed: false,
    });
    assert.equal(result.answer, UNCOVERED);
    assert.deepEqual(result.sources, []);
    assert.deepEqual(result.opened, []);
  } finally {
    resetModelProvider();
    index.close();
  }
});

test("naming a readable html file still answers from that file", async () => {
  const section = extractHtmlText(await readFile(join(fixtures, "section-b.html"), "utf8"));
  const index = new InMemoryIndex();
  seedSectionB(index, section);
  setModelProvider(sectionBNeighbor(section));
  try {
    const result = await runAskAgent({
      index,
      question: "What does section-b.html say?",
      mode: "lexical",
      readNote: async (path) => {
        if (path === "section-b.html") return section;
        if (path === "empty.html") throw new Error(HTML_NO_TEXT);
        throw new Error(`missing ${path}`);
      },
      retrievalSeed: false,
    });
    assert.equal(result.answer.includes("COPPER FINCH, 312"), true);
    assert.notEqual(result.answer, UNCOVERED);
    assert.equal(result.sources.some((source) => source.file === "section-b.html"), true);
    assert.equal(result.sources.some((source) => source.file === "empty.html"), false);
  } finally {
    resetModelProvider();
    index.close();
  }
});
