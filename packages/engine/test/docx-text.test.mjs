// Word .docx body text: headings, tables, deletions, damaged packages, and citations.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { docxBuffer, zipEntries } from "./docx-zip.mjs";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const UNCOVERED = "Your notes don't cover this.";
const CHINESE_HEADING = "第二節";
const CHINESE_BODY = "這份筆記記載欄位代碼銅雀與編號三一二。";

let extractDocxText;
let renderDocxXml;
let DOCX_NO_TEXT;
let DOCX_UNREADABLE;
let DOCX_TEXT_CAP;
let limitDocxText;
let isIndexableVaultPath;
let discoverIndexableFiles;
let indexVault;
let openIndex;
let runAskAgent;
let runAskSearchTool;
let ask;
let setModelProvider;
let resetModelProvider;
let FakeModelProvider;
let InMemoryIndex;

before(async () => {
  const engine = await import("../dist/index.js");
  const testing = await import("../dist/testing.js");
  extractDocxText = engine.extractDocxText;
  renderDocxXml = engine.renderDocxXml;
  DOCX_NO_TEXT = engine.DOCX_NO_TEXT;
  DOCX_UNREADABLE = engine.DOCX_UNREADABLE;
  DOCX_TEXT_CAP = engine.DOCX_TEXT_CAP;
  limitDocxText = engine.limitDocxText;
  isIndexableVaultPath = engine.isIndexableVaultPath;
  discoverIndexableFiles = engine.discoverIndexableFiles;
  indexVault = engine.indexVault;
  openIndex = engine.openIndex;
  runAskAgent = engine.runAskAgent;
  runAskSearchTool = engine.runAskSearchTool;
  ask = engine.ask;
  setModelProvider = engine.setModelProvider;
  resetModelProvider = engine.resetModelProvider;
  FakeModelProvider = testing.FakeModelProvider;
  InMemoryIndex = testing.InMemoryIndex;
});

after(() => resetModelProvider?.());

function documentXml(body) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`;
}

function paragraph(inner, style) {
  const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : "";
  return `<w:p>${pPr}${inner}</w:p>`;
}

function run(text) {
  return `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
}

const LOCALIZED_STYLES = `<w:styles xmlns:w="${W}">
  <w:style w:type="paragraph" w:styleId="berschrift1">
    <w:name w:val="Überschrift1"/>
    <w:pPr><w:outlineLvl w:val="0"/></w:pPr>
  </w:style>
</w:styles>`;

async function tempDir() {
  return mkdtemp(join(tmpdir(), "cairn-docx-"));
}

async function writeDocx(root, name, xml, styles) {
  await writeFile(join(root, name), docxBuffer(xml, styles));
}

test("headings, body, table, tab, break, and deletions extract as text", async () => {
  const root = await tempDir();
  try {
    const body = [
      paragraph(run("Field"), "Heading1"),
      paragraph(run("Title line"), "Title"),
      paragraph(run("Second"), "Heading2"),
      paragraph(`${run("The field code is COPPER FINCH, 312.")}`),
      paragraph(`${run("left")}<w:r><w:tab/></w:r>${run("right")}<w:r><w:br/></w:r>${run("after")}`),
      paragraph(`<w:del><w:r><w:delText>gone</w:delText></w:r></w:del>${run("kept")}`),
      `<w:tbl><w:tr><w:tc>${paragraph(run("alpha"))}</w:tc><w:tc>${paragraph(run("beta"))}</w:tc></w:tr></w:tbl>`,
    ].join("");
    await writeDocx(root, "field.docx", documentXml(body));
    const text = extractDocxText(join(root, "field.docx"));
    assert.match(text, /^# Field$/m);
    assert.match(text, /^# Title line$/m);
    assert.match(text, /^## Second$/m);
    assert.match(text, /COPPER FINCH, 312/);
    assert.match(text, /left\tright\nafter/);
    assert.match(text, /^kept$/m);
    assert.equal(text.includes("gone"), false);
    assert.match(text, /^alpha \| beta$/m);
    assert.equal(text.includes("<"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a localized style uses outline level, and a Chinese heading survives", async () => {
  const root = await tempDir();
  try {
    const xml = documentXml(
      [
        paragraph(run(CHINESE_HEADING), "berschrift1"),
        paragraph(run(CHINESE_BODY)),
      ].join(""),
    );
    await writeDocx(root, "field.docx", xml, LOCALIZED_STYLES);
    const text = extractDocxText(join(root, "field.docx"));
    assert.match(text, new RegExp(`^# ${CHINESE_HEADING}$`, "m"));
    assert.match(text, new RegExp(CHINESE_BODY));
    assert.equal(renderDocxXml(xml, LOCALIZED_STYLES).includes(CHINESE_HEADING), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("empty, OLE, truncated, and missing document.xml are the docx errors", async () => {
  const root = await tempDir();
  try {
    await writeDocx(root, "empty.docx", documentXml("<w:sectPr/>"));
    await assert.rejects(() => Promise.resolve().then(() => extractDocxText(join(root, "empty.docx"))), {
      message: DOCX_NO_TEXT,
    });
    await writeFile(join(root, "locked.docx"), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]));
    await assert.rejects(() => Promise.resolve().then(() => extractDocxText(join(root, "locked.docx"))), {
      message: DOCX_UNREADABLE,
    });
    const whole = docxBuffer(documentXml(paragraph(run("hi"))));
    await writeFile(join(root, "cut.docx"), whole.subarray(0, 12));
    await assert.rejects(() => Promise.resolve().then(() => extractDocxText(join(root, "cut.docx"))), {
      message: DOCX_UNREADABLE,
    });
    await writeFile(join(root, "nostory.docx"), zipEntries([{ name: "word/styles.xml", data: "<w:styles/>" }]));
    await assert.rejects(() => Promise.resolve().then(() => extractDocxText(join(root, "nostory.docx"))), {
      message: DOCX_UNREADABLE,
    });
    const bomb = zipEntries([
      {
        name: "word/document.xml",
        data: "x",
        uncompressedSize: 60 * 1024 * 1024,
      },
    ]);
    await writeFile(join(root, "bomb.docx"), bomb);
    await assert.rejects(() => Promise.resolve().then(() => extractDocxText(join(root, "bomb.docx"))), {
      message: DOCX_UNREADABLE,
    });
    assert.equal(DOCX_NO_TEXT, "This Word file has no readable text, so Cairn cannot read it.");
    assert.equal(DOCX_UNREADABLE, "This Word file is password-protected or damaged, so Cairn cannot read it.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extracted text is capped at 2 MB", async () => {
  assert.equal(DOCX_TEXT_CAP, 2 * 1024 * 1024);
  assert.equal(limitDocxText("abcdef", 4), "abcd");
  const root = await tempDir();
  try {
    const huge = "字".repeat(DOCX_TEXT_CAP + 40);
    await writeDocx(root, "huge.docx", documentXml(paragraph(run(huge))));
    const text = extractDocxText(join(root, "huge.docx"));
    assert.equal(text.length, DOCX_TEXT_CAP);
    assert.equal(text.startsWith("字"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(".doc, .docm, and .dotx stay unindexed; a docx chunk keeps its heading", async () => {
  assert.equal(isIndexableVaultPath("notes/field.docx"), true);
  assert.equal(isIndexableVaultPath("notes/field.DOCX"), true);
  assert.equal(isIndexableVaultPath("notes/old.doc"), false);
  assert.equal(isIndexableVaultPath("notes/macro.docm"), false);
  assert.equal(isIndexableVaultPath("notes/template.dotx"), false);
  const root = await tempDir();
  try {
    const body = [
      paragraph(run("Section B"), "Heading1"),
      paragraph(run("The field code is COPPER FINCH, 312 under Section B.")),
    ].join("");
    await writeDocx(root, "field.docx", documentXml(body));
    await writeFile(join(root, "broken.docx"), Buffer.from("this is not a zip"));
    await writeFile(join(root, "old.doc"), Buffer.from("legacy"));
    await writeFile(join(root, "neighbor.md"), "# Project Heron\n\nNo code here.\n");
    const names = discoverIndexableFiles(root).map((abs) => abs.split("/").pop());
    assert.ok(names.includes("field.docx"));
    assert.ok(names.includes("broken.docx"));
    assert.equal(names.includes("old.doc"), false);
    const stats = await indexVault(root, { lexical: true });
    assert.equal(stats.files, 3);
    const index = openIndex(root);
    try {
      const files = index.listFiles();
      assert.ok(files.includes("field.docx"));
      assert.ok(files.includes("neighbor.md"));
      assert.equal(files.includes("broken.docx"), false);
      const raw = await runAskSearchTool(
        "grep",
        { pattern: "COPPER FINCH" },
        { index, readNote: async () => "" },
        { sources: [], opened: [] },
      );
      const match = JSON.parse(raw).matches.find((item) => item.file === "field.docx");
      assert.ok(match);
      assert.equal(match.heading, "Section B");
      assert.match(match.snippet, /312/);
    } finally {
      index.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read returns docx text with its heading and refuses a damaged file", async () => {
  const fact = "# Section B\nThe field code is COPPER FINCH, 312 under Section B.";
  const index = new InMemoryIndex();
  try {
    const readNote = async (path) => {
      if (path === "field.docx") return fact;
      if (path === "broken.docx") throw new Error(DOCX_UNREADABLE);
      throw new Error(`missing ${path}`);
    };
    const good = { sources: [], opened: [] };
    const body = await runAskSearchTool("read", { path: "field.docx" }, { index, readNote }, good);
    assert.match(body, /COPPER FINCH, 312/);
    assert.equal(body.length <= 8000 || body.includes("truncated"), true);
    assert.equal(good.sources[0].file, "field.docx");
    assert.equal(good.sources[0].heading, "Section B");
    const bad = { sources: [], opened: [] };
    const message = await runAskSearchTool("read", { path: "broken.docx" }, { index, readNote }, bad);
    assert.equal(message, `ERROR: ${DOCX_UNREADABLE}`);
    assert.deepEqual(bad.sources, []);
    assert.equal(bad.textlessDocx, true);
    const opened = { sources: [], opened: [] };
    const openMessage = await runAskSearchTool(
      "open",
      { path: "broken.docx", line: 1 },
      { index, readNote },
      opened,
    );
    assert.equal(openMessage, `ERROR: ${DOCX_UNREADABLE}`);
    assert.deepEqual(opened.opened, []);
  } finally {
    index.close();
  }
});

test("agentic ask cites file.docx with its heading", async () => {
  const root = await tempDir();
  try {
    const body = [
      paragraph(run("Section B"), "Heading1"),
      paragraph(run("The field code is COPPER FINCH, 312 under Section B.")),
    ].join("");
    await writeDocx(root, "field.docx", documentXml(body));
    await indexVault(root, { lexical: true });
    const index = openIndex(root);
    let system = "";
    setModelProvider(
      new FakeModelProvider({
        models: ["qwen3:4b"],
        chatWithTools: async (_model, messages, _tools, turn) => {
          system = messages[0].content;
          if (turn === 1) {
            return { content: "", toolCalls: [{ name: "grep", arguments: { pattern: "COPPER FINCH" } }] };
          }
          return { content: "The field code is COPPER FINCH, 312.", toolCalls: [] };
        },
      }),
    );
    try {
      const result = await runAskAgent({
        index,
        question: "What is the field code?",
        mode: "lexical",
        readNote: async (path) => extractDocxText(join(root, path)),
        retrievalSeed: false,
      });
      assert.match(system, /\[file\.docx:line\]/);
      assert.match(system, /heading/i);
      assert.equal(result.answer.includes("312"), true);
      const hit = result.sources.find((source) => source.file === "field.docx");
      assert.ok(hit);
      assert.equal(hit.heading, "Section B");
    } finally {
      resetModelProvider();
      index.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a named broken docx is a miss with zero chips", async () => {
  let calls = 0;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async () => {
        calls += 1;
        return {
          content: "",
          toolCalls: [{ name: "read", arguments: { path: "neighbor.md" } }],
        };
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    index.rebuildIndex({
      mode: "lexical",
      files: 1,
      chunks: [
        {
          id: 1,
          file: "neighbor.md",
          ordinal: 0,
          line: 1,
          heading: "Project Heron",
          text: "The notebook codename is COPPER FINCH and the badge is 999.",
          hash: "neighbor",
        },
      ],
    });
    const result = await runAskAgent({
      index,
      question: "What does broken.docx say?",
      mode: "lexical",
      readNote: async (path) => {
        if (path === "broken.docx") throw new Error(DOCX_UNREADABLE);
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
  } finally {
    resetModelProvider();
    index.close();
  }
});

test("classic ask cites the docx chunk", async () => {
  const root = await tempDir();
  try {
    const body = [
      paragraph(run(CHINESE_HEADING), "berschrift1"),
      paragraph(run("The field code is COPPER FINCH, 312 under Section B.")),
    ].join("");
    await writeDocx(root, "field.docx", documentXml(body), LOCALIZED_STYLES);
    await indexVault(root, { lexical: true });
    const index = openIndex(root);
    setModelProvider(
      new FakeModelProvider({
        models: ["qwen3:4b"],
        chat: async () => "The field code is COPPER FINCH, 312 [1].",
      }),
    );
    try {
      const result = await ask(index, "What is the field code?", { mode: "lexical" });
      assert.equal(result.covered, true);
      const hit = result.sources.find((source) => source.file === "field.docx");
      assert.ok(hit);
      assert.equal(hit.heading, CHINESE_HEADING);
      assert.match(hit.text, /312/);
    } finally {
      resetModelProvider();
      index.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
