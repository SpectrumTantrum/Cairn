// PowerPoint .pptx slide text: real sldIdLst order, notes, hidden slides, and citations.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { zipEntries } from "./docx-zip.mjs";

const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const RELS = "http://schemas.openxmlformats.org/package/2006/relationships";
const UNCOVERED = "Your notes don't cover this.";
const CHINESE_TITLE = "中文標題";
const CHINESE_BODY = "這份簡報記載欄位代碼。";
const CHINESE_NOTES = "講者備註只在這一頁。";

let extractPptxText;
let PPTX_NO_TEXT;
let PPTX_UNREADABLE;
let PPTX_TEXT_CAP;
let PPTX_SLIDE_CAP;
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
  extractPptxText = engine.extractPptxText;
  PPTX_NO_TEXT = engine.PPTX_NO_TEXT;
  PPTX_UNREADABLE = engine.PPTX_UNREADABLE;
  PPTX_TEXT_CAP = engine.PPTX_TEXT_CAP;
  PPTX_SLIDE_CAP = engine.PPTX_SLIDE_CAP;
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

function para(text) {
  return `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`;
}

function shape(ph, paragraphs, name = "Shape") {
  const phXml = ph ? `<p:nvPr><p:ph type="${ph}"/></p:nvPr>` : "<p:nvPr/>";
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="${name}"/><p:cNvSpPr/>${phXml}</p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
}

function slideXml(inner) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${inner}</p:spTree></p:cSld></p:sld>`;
}

function notesXml(bodyParagraphs) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="${A}" xmlns:p="${P}"><p:cSld><p:spTree>
${shape("hdr", para("HEADER SKIP"))}
${shape("sldNum", para("SLIDENUM SKIP"))}
${shape("ftr", para("FOOTER SKIP"))}
${shape("dt", para("DATE SKIP"))}
${shape("body", bodyParagraphs)}
</p:spTree></p:cSld></p:notes>`;
}

function presentationXml(slides) {
  const ids = slides
    .map((slide, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"${slide.hidden ? ' show="0"' : ""}/>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"><p:sldIdLst>${ids}</p:sldIdLst></p:presentation>`;
}

function presentationRels(slides) {
  const rels = slides
    .map(
      (slide, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="${slide.target}"/>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${RELS}">${rels}</Relationships>`;
}

function notesRels(notesTarget) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${RELS}"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="${notesTarget}"/></Relationships>`;
}

/** `slides` are in sldIdLst order. `zipOrder` is the order of slide parts inside the zip. */
function pptxBuffer(slides, zipOrder = slides.map((_, i) => i)) {
  const entries = [];
  zipOrder.forEach((index) => {
    const slide = slides[index];
    entries.push({ name: `ppt/${slide.target}`, data: slide.xml });
    if (slide.notes) {
      const notesName = slide.notesName;
      entries.push({ name: notesName, data: slide.notes });
      const base = slide.target.split("/").pop();
      entries.push({
        name: `ppt/slides/_rels/${base}.rels`,
        data: notesRels(slide.notesTarget),
      });
    }
  });
  entries.push({ name: "ppt/presentation.xml", data: presentationXml(slides) });
  entries.push({ name: "ppt/_rels/presentation.xml.rels", data: presentationRels(slides) });
  entries.push({
    name: "ppt/slideMasters/slideMaster1.xml",
    data: slideXml(shape("title", para("MASTER SECRET"))),
  });
  entries.push({
    name: "ppt/comments/comment1.xml",
    data: "<p:cmLst><p:cm><p:text>COMMENT SECRET</p:text></p:cm></p:cmLst>",
  });
  return zipEntries(entries);
}

function reorderDeck() {
  const grouped = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="9" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shape("body", para("GROUPED LINE"), "Grouped")}</p:grpSp>`;
  const broken = `<a:p><a:r><a:t>left</a:t></a:r><a:br/><a:r><a:t>right</a:t></a:r></a:p>`;
  const table = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="8" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tr><a:tc><a:txBody><a:bodyPr/>${para("alpha")}</a:txBody></a:tc><a:tc><a:txBody><a:bodyPr/>${para("beta")}</a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
  const chart = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="11" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:v>CHART SECRET</c:v></c:chart></a:graphicData></a:graphic></p:graphicFrame>`;
  const pic = `<p:pic><p:nvPicPr><p:cNvPr id="7" name="Picture" descr="ALT SECRET"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill/><p:spPr/></p:pic>`;
  const slide2 = {
    target: "slides/slide2.xml",
    xml: slideXml(`${shape("title", para("Opening"), "Title")}${shape("body", para("Intro line"), "Body")}`),
  };
  const slide1 = {
    target: "slides/slide1.xml",
    xml: slideXml(`${shape("ctrTitle", para(CHINESE_TITLE), "Title")}${shape("body", para(CHINESE_BODY), "Body")}`),
    notes: notesXml(para(CHINESE_NOTES)),
    notesName: "ppt/notesSlides/notesSlide1.xml",
    notesTarget: "../notesSlides/notesSlide1.xml",
  };
  const slide3 = {
    target: "slides/slide3.xml",
    xml: slideXml(
      [
        shape("title", para("Title"), "Title"),
        grouped,
        shape("", broken, "Break"),
        table,
        shape("body", para("The vault token is QUARTZ RIDGE."), "Body"),
        chart,
        pic,
      ].join(""),
    ),
    notes: notesXml(para("The speaker-only token is AMBER NOTE.")),
    notesName: "ppt/notesSlides/notesSlide3.xml",
    notesTarget: "../notesSlides/notesSlide3.xml",
  };
  const slide4 = {
    target: "slides/slide4.xml",
    hidden: true,
    xml: slideXml(`${shape("title", para("Secret"), "Title")}${shape("body", para("hidden body"), "Body")}`),
  };
  const slide5 = {
    target: "slides/slide5.xml",
    xml: slideXml(shape("body", para("Plain body with no title."), "Body")),
  };
  // sldIdLst order is slide2, slide1, slide3, slide4, slide5.
  // Zip and file-name order is slide3, slide1, slide2, then the rest.
  const slides = [slide2, slide1, slide3, slide4, slide5];
  return pptxBuffer(slides, [2, 1, 0, 3, 4]);
}

const EXPECTED = [
  "# Slide 1 · Opening",
  "Intro line",
  `# Slide 2 · ${CHINESE_TITLE}`,
  CHINESE_BODY,
  `Notes: ${CHINESE_NOTES}`,
  "# Slide 3 · Title",
  "GROUPED LINE",
  "left",
  "right",
  "alpha | beta",
  "The vault token is QUARTZ RIDGE.",
  "Notes: The speaker-only token is AMBER NOTE.",
  "# Slide 4 · Secret (hidden)",
  "hidden body",
  "# Slide 5",
  "Plain body with no title.",
].join("\n");

async function tempDir() {
  return mkdtemp(join(tmpdir(), "cairn-pptx-"));
}

test("sldIdLst order, titles, group, table, break, notes, and a hidden slide", async () => {
  const root = await tempDir();
  try {
    await writeFile(join(root, "deck.pptx"), reorderDeck());
    const text = extractPptxText(join(root, "deck.pptx"));
    assert.equal(text, EXPECTED);
    assert.equal(text.includes("CHART SECRET"), false);
    assert.equal(text.includes("ALT SECRET"), false);
    assert.equal(text.includes("MASTER SECRET"), false);
    assert.equal(text.includes("COMMENT SECRET"), false);
    assert.equal(text.includes("HEADER SKIP"), false);
    assert.equal(text.includes("FOOTER SKIP"), false);
    assert.equal(text.includes("SLIDENUM SKIP"), false);
    assert.equal(text.includes("DATE SKIP"), false);
    const heading = text.match(/^# (Slide 2 · .+)$/m)?.[1];
    assert.equal(heading, `Slide 2 · ${CHINESE_TITLE}`);
    assert.equal(`deck.pptx · ${heading}`, `deck.pptx · Slide 2 · ${CHINESE_TITLE}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a picture-only slide is omitted and later slides keep their PowerPoint numbers", async () => {
  const root = await tempDir();
  try {
    const slides = [
      {
        target: "slides/slide1.xml",
        xml: slideXml(`${shape("title", para("One"))}${shape("body", para("first"))}`),
      },
      {
        target: "slides/slide2.xml",
        xml: slideXml(`<p:pic><p:nvPicPr><p:cNvPr id="4" name="Pic" descr="ALT SECRET"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr></p:pic>`),
      },
      {
        target: "slides/slide3.xml",
        xml: slideXml(`${shape("title", para("Three"))}${shape("body", para("third"))}`),
      },
    ];
    await writeFile(join(root, "gaps.pptx"), pptxBuffer(slides));
    const text = extractPptxText(join(root, "gaps.pptx"));
    assert.equal(text, ["# Slide 1 · One", "first", "# Slide 3 · Three", "third"].join("\n"));
    assert.equal(text.includes("# Slide 2"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("empty, OLE, truncated, missing presentation, dangling r:id, encrypted, and bomb are the pptx errors", async () => {
  const root = await tempDir();
  try {
    const empty = pptxBuffer([]);
    // presentationXml of [] is an empty sldIdLst. pptxBuffer still writes it.
    await writeFile(join(root, "empty.pptx"), empty);
    await assert.rejects(() => Promise.resolve().then(() => extractPptxText(join(root, "empty.pptx"))), {
      message: PPTX_NO_TEXT,
    });
    await writeFile(join(root, "locked.pptx"), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]));
    await assert.rejects(() => Promise.resolve().then(() => extractPptxText(join(root, "locked.pptx"))), {
      message: PPTX_UNREADABLE,
    });
    const whole = reorderDeck();
    await writeFile(join(root, "cut.pptx"), whole.subarray(0, 12));
    await assert.rejects(() => Promise.resolve().then(() => extractPptxText(join(root, "cut.pptx"))), {
      message: PPTX_UNREADABLE,
    });
    await writeFile(join(root, "nopres.pptx"), zipEntries([{ name: "ppt/slides/slide1.xml", data: "<p:sld/>" }]));
    await assert.rejects(() => Promise.resolve().then(() => extractPptxText(join(root, "nopres.pptx"))), {
      message: PPTX_UNREADABLE,
    });
    const dangling = zipEntries([
      {
        name: "ppt/presentation.xml",
        data: presentationXml([{ hidden: false }]),
      },
      {
        name: "ppt/_rels/presentation.xml.rels",
        data: presentationRels([{ target: "slides/missing.xml" }]),
      },
    ]);
    await writeFile(join(root, "dangling.pptx"), dangling);
    await assert.rejects(() => Promise.resolve().then(() => extractPptxText(join(root, "dangling.pptx"))), {
      message: PPTX_UNREADABLE,
    });
    const unknownId = zipEntries([
      {
        name: "ppt/presentation.xml",
        data: `<p:presentation xmlns:r="${R}" xmlns:p="${P}"><p:sldIdLst><p:sldId id="1" r:id="rIdMissing"/></p:sldIdLst></p:presentation>`,
      },
      {
        name: "ppt/_rels/presentation.xml.rels",
        data: `<Relationships xmlns="${RELS}"/>`,
      },
    ]);
    await writeFile(join(root, "norid.pptx"), unknownId);
    await assert.rejects(() => Promise.resolve().then(() => extractPptxText(join(root, "norid.pptx"))), {
      message: PPTX_UNREADABLE,
    });
    await writeFile(
      join(root, "encrypted.pptx"),
      zipEntries([{ name: "ppt/presentation.xml", data: "<p:presentation/>", flags: 1 }]),
    );
    await assert.rejects(() => Promise.resolve().then(() => extractPptxText(join(root, "encrypted.pptx"))), {
      message: PPTX_UNREADABLE,
    });
    await writeFile(
      join(root, "bomb.pptx"),
      zipEntries([{ name: "ppt/presentation.xml", data: "x", uncompressedSize: 60 * 1024 * 1024 }]),
    );
    await assert.rejects(() => Promise.resolve().then(() => extractPptxText(join(root, "bomb.pptx"))), {
      message: PPTX_UNREADABLE,
    });
    assert.equal(PPTX_NO_TEXT, "This PowerPoint file has no readable text, so Cairn cannot read it.");
    assert.equal(PPTX_UNREADABLE, "This PowerPoint file is password-protected or damaged, so Cairn cannot read it.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("more than 2000 slides or more than 2 MB of text is unreadable", async () => {
  assert.equal(PPTX_SLIDE_CAP, 2000);
  assert.equal(PPTX_TEXT_CAP, 2 * 1024 * 1024);
  const root = await tempDir();
  try {
    const ids = Array.from({ length: PPTX_SLIDE_CAP + 1 }, (_, i) => `<p:sldId id="${i + 1}" r:id="rId${i + 1}"/>`).join("");
    const tooMany = zipEntries([
      {
        name: "ppt/presentation.xml",
        data: `<p:presentation xmlns:r="${R}" xmlns:p="${P}"><p:sldIdLst>${ids}</p:sldIdLst></p:presentation>`,
      },
    ]);
    await writeFile(join(root, "many.pptx"), tooMany);
    await assert.rejects(() => Promise.resolve().then(() => extractPptxText(join(root, "many.pptx"))), {
      message: PPTX_UNREADABLE,
    });
    const huge = "字".repeat(PPTX_TEXT_CAP);
    const fat = pptxBuffer([
      {
        target: "slides/slide1.xml",
        xml: slideXml(`${shape("title", para("Big"))}${shape("body", para(huge))}`),
      },
    ]);
    await writeFile(join(root, "huge.pptx"), fat);
    await assert.rejects(() => Promise.resolve().then(() => extractPptxText(join(root, "huge.pptx"))), {
      message: PPTX_UNREADABLE,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(".ppt, .pptm, .ppsx, and .potx stay unindexed; a pptx chunk keeps its slide heading", async () => {
  assert.equal(isIndexableVaultPath("notes/deck.pptx"), true);
  assert.equal(isIndexableVaultPath("notes/deck.PPTX"), true);
  assert.equal(isIndexableVaultPath("notes/old.ppt"), false);
  assert.equal(isIndexableVaultPath("notes/macro.pptm"), false);
  assert.equal(isIndexableVaultPath("notes/show.ppsx"), false);
  assert.equal(isIndexableVaultPath("notes/template.potx"), false);
  const root = await tempDir();
  try {
    await writeFile(join(root, "deck.pptx"), reorderDeck());
    await writeFile(join(root, "broken.pptx"), Buffer.from("this is not a zip"));
    await writeFile(join(root, "old.ppt"), Buffer.from("legacy"));
    await writeFile(join(root, "macro.pptm"), Buffer.from("macro"));
    await writeFile(join(root, "show.ppsx"), Buffer.from("show"));
    await writeFile(join(root, "template.potx"), Buffer.from("template"));
    await writeFile(join(root, "neighbor.md"), "# Project Heron\n\nNo code here.\n");
    const names = discoverIndexableFiles(root).map((abs) => abs.split("/").pop());
    assert.ok(names.includes("deck.pptx"));
    assert.ok(names.includes("broken.pptx"));
    assert.equal(names.includes("old.ppt"), false);
    assert.equal(names.includes("macro.pptm"), false);
    assert.equal(names.includes("show.ppsx"), false);
    assert.equal(names.includes("template.potx"), false);
    const stats = await indexVault(root, { lexical: true });
    assert.equal(stats.files, 3);
    const index = openIndex(root);
    try {
      const files = index.listFiles();
      assert.ok(files.includes("deck.pptx"));
      assert.ok(files.includes("neighbor.md"));
      assert.equal(files.includes("broken.pptx"), false);
      const listed = JSON.parse(
        await runAskSearchTool("list", {}, { index, readNote: async () => "" }, { sources: [], opened: [] }),
      );
      assert.ok(listed.paths.includes("deck.pptx"));
      const raw = await runAskSearchTool(
        "grep",
        { pattern: "QUARTZ RIDGE" },
        { index, readNote: async () => "" },
        { sources: [], opened: [] },
      );
      const match = JSON.parse(raw).matches.find((item) => item.file === "deck.pptx");
      assert.ok(match);
      assert.equal(match.heading, "Slide 3 · Title");
      assert.equal(match.line, EXPECTED.split("\n").findIndex((line) => line.includes("QUARTZ RIDGE")) + 1);
      const notes = JSON.parse(
        await runAskSearchTool(
          "grep",
          { pattern: "AMBER NOTE" },
          { index, readNote: async () => "" },
          { sources: [], opened: [] },
        ),
      ).matches.find((item) => item.file === "deck.pptx");
      assert.equal(notes.heading, "Slide 3 · Title");
    } finally {
      index.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read returns pptx text with its first slide heading and refuses a damaged deck", async () => {
  const fact = EXPECTED;
  const index = new InMemoryIndex();
  try {
    const readNote = async (path) => {
      if (path === "deck.pptx") return fact;
      if (path === "broken.pptx") throw new Error(PPTX_UNREADABLE);
      if (path === "empty.pptx") throw new Error(PPTX_NO_TEXT);
      throw new Error(`missing ${path}`);
    };
    const good = { sources: [], opened: [] };
    const body = await runAskSearchTool("read", { path: "deck.pptx" }, { index, readNote }, good);
    assert.match(body, /QUARTZ RIDGE/);
    assert.match(body, new RegExp(CHINESE_NOTES));
    assert.equal(good.sources[0].file, "deck.pptx");
    assert.equal(good.sources[0].heading, "Slide 1 · Opening");
    const bad = { sources: [], opened: [] };
    const message = await runAskSearchTool("read", { path: "broken.pptx" }, { index, readNote }, bad);
    assert.equal(message, `ERROR: ${PPTX_UNREADABLE}`);
    assert.deepEqual(bad.sources, []);
    assert.equal(bad.textlessPptx, true);
    const empty = { sources: [], opened: [] };
    const emptyMessage = await runAskSearchTool("read", { path: "empty.pptx" }, { index, readNote }, empty);
    assert.equal(emptyMessage, `ERROR: ${PPTX_NO_TEXT}`);
    assert.equal(empty.textlessPptx, true);
    const opened = { sources: [], opened: [] };
    const openMessage = await runAskSearchTool(
      "open",
      { path: "broken.pptx", line: 1 },
      { index, readNote },
      opened,
    );
    assert.equal(openMessage, `ERROR: ${PPTX_UNREADABLE}`);
    assert.deepEqual(opened.opened, []);
  } finally {
    index.close();
  }
});

test("agentic ask cites deck.pptx at the slide heading, including a notes-only fact", async () => {
  const root = await tempDir();
  try {
    await writeFile(join(root, "deck.pptx"), reorderDeck());
    await indexVault(root, { lexical: true });
    const index = openIndex(root);
    const readNote = async (path) => extractPptxText(join(root, path));
    let system = "";
    setModelProvider(
      new FakeModelProvider({
        models: ["qwen3:4b"],
        chatWithTools: async (_model, messages, _tools, turn) => {
          system = messages[0].content;
          if (turn === 1) return { content: "", toolCalls: [{ name: "grep", arguments: { pattern: "QUARTZ RIDGE" } }] };
          return { content: "The vault token is QUARTZ RIDGE.", toolCalls: [] };
        },
      }),
    );
    try {
      const result = await runAskAgent({
        index,
        question: "What is the vault token?",
        mode: "lexical",
        readNote,
        retrievalSeed: false,
      });
      assert.match(system, /\[deck\.pptx:line\]/);
      assert.match(system, /slide heading/);
      assert.equal(result.answer.includes("QUARTZ RIDGE"), true);
      const hit = result.sources.find((source) => source.file === "deck.pptx");
      assert.ok(hit);
      assert.equal(hit.heading, "Slide 3 · Title");
      assert.equal(`deck.pptx · ${hit.heading}`, "deck.pptx · Slide 3 · Title");
    } finally {
      resetModelProvider();
    }
    setModelProvider(
      new FakeModelProvider({
        models: ["qwen3:4b"],
        chatWithTools: async (_model, _messages, _tools, turn) => {
          if (turn === 1) return { content: "", toolCalls: [{ name: "grep", arguments: { pattern: "AMBER NOTE" } }] };
          return { content: "The speaker-only token is AMBER NOTE.", toolCalls: [] };
        },
      }),
    );
    try {
      const result = await runAskAgent({
        index,
        question: "What is the speaker-only token?",
        mode: "lexical",
        readNote,
        retrievalSeed: false,
      });
      const hit = result.sources.find((source) => source.file === "deck.pptx");
      assert.ok(hit);
      assert.equal(hit.heading, "Slide 3 · Title");
      assert.match(hit.text, /AMBER NOTE/);
    } finally {
      resetModelProvider();
      index.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a named broken pptx is a miss with zero chips", async () => {
  let calls = 0;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async () => {
        calls += 1;
        return { content: "", toolCalls: [{ name: "read", arguments: { path: "neighbor.md" } }] };
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
      question: "What does broken.pptx say?",
      mode: "lexical",
      readNote: async (path) => {
        if (path === "broken.pptx") throw new Error(PPTX_UNREADABLE);
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

test("classic ask cites the pptx slide", async () => {
  const root = await tempDir();
  try {
    await writeFile(join(root, "deck.pptx"), reorderDeck());
    await indexVault(root, { lexical: true });
    const index = openIndex(root);
    setModelProvider(
      new FakeModelProvider({
        models: ["qwen3:4b"],
        chat: async () => "The vault token is QUARTZ RIDGE [1].",
      }),
    );
    try {
      const result = await ask(index, "What is the vault token QUARTZ RIDGE?", { mode: "lexical" });
      assert.equal(result.covered, true);
      const hit = result.sources.find((source) => source.file === "deck.pptx");
      assert.ok(hit);
      assert.equal(hit.heading, "Slide 3 · Title");
      assert.match(hit.text, /QUARTZ RIDGE/);
    } finally {
      resetModelProvider();
    }
    setModelProvider(
      new FakeModelProvider({
        models: ["qwen3:4b"],
        chat: async () => "The speaker-only token is AMBER NOTE [1].",
      }),
    );
    try {
      const notes = await ask(index, "What is the speaker-only token AMBER NOTE?", { mode: "lexical" });
      assert.equal(notes.covered, true);
      const hit = notes.sources.find((source) => source.file === "deck.pptx");
      assert.ok(hit);
      assert.equal(hit.heading, "Slide 3 · Title");
      assert.match(hit.text, /AMBER NOTE/);
    } finally {
      resetModelProvider();
      index.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
