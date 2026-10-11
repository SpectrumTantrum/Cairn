// CSV and TSV for agentic Ask: raw UTF-8 rows, header kept, chunked like plain text.
// Invalid UTF-8 and empty tables are not readable. A question that names one is an honest miss.

import assert from "node:assert/strict";
import { mkdtemp, cp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "csv");
const CSV_FACT = "The field code is COPPER FINCH, 312 under Section B.";
const UNCOVERED = "Your notes don't cover this.";

let EMPTY_TABLE_MESSAGE;
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
  EMPTY_TABLE_MESSAGE = engine.EMPTY_TABLE_MESSAGE;
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
  const root = await mkdtemp(join(tmpdir(), "cairn-csv-"));
  for (const name of names) await cp(join(fixtures, name), join(root, name));
  return root;
}

async function readFixture(name) {
  return readFile(join(fixtures, name), "utf8");
}

function sectionBNeighbor(text) {
  return new FakeModelProvider({
    models: ["qwen3:4b"],
    chatWithTools: async (_model, _messages, _tools, turn) => {
      if (turn === 1) {
        return {
          content: "",
          toolCalls: [
            { name: "read", arguments: { path: "section-b.csv" } },
            { name: "open", arguments: { path: "section-b.csv", line: 1 } },
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
        file: "section-b.csv",
        ordinal: 0,
        line: 1,
        heading: "",
        text,
        hash: "section-b-csv",
      },
    ],
  });
}

test("a csv file keeps its header and an empty or invalid table is skipped", async () => {
  const root = await vaultWith(["section-b.csv", "project-heron.md", "empty.csv", "junk.csv", "rows.tsv"]);
  try {
    const names = discoverIndexableFiles(root).map((abs) => basename(abs));
    assert.ok(names.includes("section-b.csv"));
    assert.ok(names.includes("project-heron.md"));
    assert.ok(names.includes("empty.csv"));
    assert.ok(names.includes("rows.tsv"));
    assert.equal(names.includes("junk.csv"), false);
    const markdown = discoverMarkdownFiles(root).map((abs) => basename(abs));
    assert.deepEqual(markdown, ["project-heron.md"]);

    const stats = await indexVault(root, { lexical: true });
    assert.equal(stats.files, 4);
    const index = openIndex(root);
    try {
      const files = index.listFiles();
      assert.ok(files.includes("section-b.csv"));
      assert.ok(files.includes("project-heron.md"));
      assert.ok(files.includes("rows.tsv"));
      assert.equal(files.includes("empty.csv"), false);
      assert.equal(files.includes("junk.csv"), false);

      const state = { sources: [], opened: [] };
      const raw = await runAskSearchTool("grep", { pattern: "312" }, { index, readNote: async () => "" }, state);
      const parsed = JSON.parse(raw);
      assert.equal(parsed.matches.length, 1);
      assert.equal(parsed.matches[0].file, "section-b.csv");
      assert.equal(parsed.matches[0].line, 3);
      assert.equal(parsed.matches[0].heading, undefined);
      assert.match(parsed.matches[0].snippet, /COPPER FINCH/);

      const { hits } = await search(index, "312", { mode: "lexical" });
      assert.equal(hits.length >= 1, true);
      assert.equal(hits.every((hit) => hit.file === "section-b.csv"), true);
      assert.match(hits[0].text, /section,code,note/);
      assert.match(hits[0].text, /COPPER FINCH, 312 under Section B/);
      assert.equal(hits[0].heading, "");

      const listed = JSON.parse(
        await runAskSearchTool("list", {}, { index, readNote: async () => "" }, { sources: [], opened: [] }),
      );
      assert.ok(listed.paths.includes("section-b.csv"));
      assert.ok(listed.paths.includes("rows.tsv"));
      assert.equal(listed.paths.includes("empty.csv"), false);
      assert.equal(listed.paths.includes("junk.csv"), false);

      const tsv = JSON.parse(
        await runAskSearchTool(
          "grep",
          { pattern: "BLUE JAY" },
          { index, readNote: async () => "" },
          { sources: [], opened: [] },
        ),
      );
      assert.equal(tsv.matches.length, 1);
      assert.equal(tsv.matches[0].file, "rows.tsv");
      assert.equal(tsv.matches[0].line, 2);
      assert.equal(tsv.matches[0].heading, undefined);
      const tsvHits = await search(index, "BLUE JAY", { mode: "lexical" });
      assert.equal(tsvHits.hits[0].file, "rows.tsv");
      assert.equal(tsvHits.hits[0].heading, "");
      assert.match(tsvHits.hits[0].text, /section\tnote/);
    } finally {
      index.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read returns the csv fact and header and refuses an empty table with no source", async () => {
  const csv = await readFixture("section-b.csv");
  const index = new InMemoryIndex();
  try {
    const readNote = async (path) => {
      if (path === "section-b.csv") return csv;
      if (path === "empty.csv") throw new Error(EMPTY_TABLE_MESSAGE);
      if (path === "blank.csv") return " \n";
      throw new Error(`missing ${path}`);
    };
    const good = { sources: [], opened: [] };
    const body = await runAskSearchTool("read", { path: "section-b.csv" }, { index, readNote }, good);
    assert.match(body, /^section,code,note/m);
    assert.match(body, /COPPER FINCH, 312/);
    assert.equal(good.sources.length, 1);
    assert.equal(good.sources[0].file, "section-b.csv");
    assert.match(good.sources[0].text, /under Section B/);

    const bad = { sources: [], opened: [] };
    const message = await runAskSearchTool("read", { path: "empty.csv" }, { index, readNote }, bad);
    assert.equal(message, `ERROR: ${EMPTY_TABLE_MESSAGE}`);
    assert.deepEqual(bad.sources, []);
    assert.equal(bad.unreadableText, true);

    const blank = { sources: [], opened: [] };
    const blankMessage = await runAskSearchTool("read", { path: "blank.csv" }, { index, readNote }, blank);
    assert.equal(blankMessage, `ERROR: ${EMPTY_TABLE_MESSAGE}`);
    assert.deepEqual(blank.sources, []);
    assert.equal(blank.unreadableText, true);

    const opened = { sources: [], opened: [] };
    const openMessage = await runAskSearchTool("open", { path: "empty.csv", line: 1 }, { index, readNote }, opened);
    assert.equal(openMessage, `ERROR: ${EMPTY_TABLE_MESSAGE}`);
    assert.deepEqual(opened.sources, []);
    assert.deepEqual(opened.opened, []);
  } finally {
    index.close();
  }
});

test("an invented answer after an empty csv is refused and has no chip source", async () => {
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async (_model, _messages, _tools, turn) => {
        if (turn === 1) {
          return { content: "", toolCalls: [{ name: "read", arguments: { path: "empty.csv" } }] };
        }
        return { content: CSV_FACT, toolCalls: [] };
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
        throw new Error(EMPTY_TABLE_MESSAGE);
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

test("a junk csv read does not replace a neighbor the question did not name", async () => {
  const csv = await readFixture("section-b.csv");
  const index = new InMemoryIndex();
  seedSectionB(index, csv);
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async (_model, _messages, _tools, turn) => {
        if (turn === 1) {
          return {
            content: "",
            toolCalls: [
              { name: "read", arguments: { path: "junk.csv" } },
              { name: "read", arguments: { path: "section-b.csv" } },
            ],
          };
        }
        return { content: CSV_FACT, toolCalls: [] };
      },
    }),
  );
  try {
    const result = await runAskAgent({
      index,
      question: "What is the field code?",
      mode: "lexical",
      readNote: async (path) => {
        if (path === "junk.csv") throw new Error(INVALID_UTF8_MESSAGE);
        if (path === "section-b.csv") return csv;
        throw new Error(`missing ${path}`);
      },
      retrievalSeed: false,
    });
    assert.equal(result.answer, CSV_FACT);
    assert.equal(result.sources.some((source) => source.file === "section-b.csv"), true);
    assert.equal(result.sources.some((source) => source.file === "junk.csv"), false);
  } finally {
    resetModelProvider();
    index.close();
  }
});

test('QA: "What does empty.csv say?" is an honest miss and does not cite the neighbor', async () => {
  const section = await readFixture("section-b.csv");
  const index = new InMemoryIndex();
  seedSectionB(index, section);
  setModelProvider(sectionBNeighbor(section));
  try {
    const result = await runAskAgent({
      index,
      question: "What does empty.csv say?",
      mode: "lexical",
      readNote: async (path) => {
        if (path === "empty.csv") throw new Error(EMPTY_TABLE_MESSAGE);
        if (path === "section-b.csv") return section;
        throw new Error(`missing ${path}`);
      },
      retrievalSeed: false,
    });
    assert.equal(result.answer, UNCOVERED);
    assert.equal(result.answer.includes("COPPER FINCH"), false);
    assert.equal(result.answer.includes("section,code,note"), false);
    assert.deepEqual(result.sources, []);
    assert.deepEqual(result.opened, []);
    assert.equal(result.grounded, false);
    assert.equal(result.stopReason, "done");
  } finally {
    resetModelProvider();
    index.close();
  }
});

test('QA: "What does junk.csv say?" is an honest miss', async () => {
  const section = await readFixture("section-b.csv");
  const index = new InMemoryIndex();
  seedSectionB(index, section);
  setModelProvider(sectionBNeighbor(section));
  try {
    const result = await runAskAgent({
      index,
      question: "What does junk.csv say?",
      mode: "lexical",
      readNote: async (path) => {
        if (path === "junk.csv") throw new Error(INVALID_UTF8_MESSAGE);
        if (path === "section-b.csv") return section;
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

test("naming a readable csv file still answers from that file", async () => {
  const section = await readFixture("section-b.csv");
  const index = new InMemoryIndex();
  seedSectionB(index, section);
  setModelProvider(sectionBNeighbor(section));
  try {
    const result = await runAskAgent({
      index,
      question: "What does section-b.csv say?",
      mode: "lexical",
      readNote: async (path) => {
        if (path === "section-b.csv") return section;
        if (path === "empty.csv") throw new Error(EMPTY_TABLE_MESSAGE);
        throw new Error(`missing ${path}`);
      },
      retrievalSeed: false,
    });
    assert.equal(result.answer.includes("COPPER FINCH, 312"), true);
    assert.notEqual(result.answer, UNCOVERED);
    assert.equal(result.sources.some((source) => source.file === "section-b.csv"), true);
    assert.equal(result.sources.some((source) => source.file === "empty.csv"), false);
  } finally {
    resetModelProvider();
    index.close();
  }
});
