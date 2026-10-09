// Text PDFs for agentic Ask: per-page extraction, no embeddings, honest refusal
// when a PDF has no text layer, and a shared codename that must stay on the
// file that actually contains the sentence.

import assert from "node:assert/strict";
import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "pdf");
const PDF_FACT = "The field code is COPPER FINCH, 312 under Section B.";
const NOTE_FACT = "The notebook codename is COPPER FINCH and the badge is 999.";
const UNCOVERED = "Your notes don't cover this.";

let extractPdfPages;
let discoverMarkdownFiles;
let discoverIndexableFiles;
let indexVault;
let openIndex;
let embedPendingChunks;
let chunkNeedsEmbedding;
let runAskAgent;
let runAskSearchTool;
let setModelProvider;
let resetModelProvider;
let FakeModelProvider;
let InMemoryIndex;

before(async () => {
  const engine = await import("../dist/index.js");
  const testing = await import("../dist/testing.js");
  extractPdfPages = engine.extractPdfPages;
  discoverMarkdownFiles = engine.discoverMarkdownFiles;
  discoverIndexableFiles = engine.discoverIndexableFiles;
  indexVault = engine.indexVault;
  openIndex = engine.openIndex;
  embedPendingChunks = engine.embedPendingChunks;
  chunkNeedsEmbedding = engine.chunkNeedsEmbedding;
  runAskAgent = engine.runAskAgent;
  runAskSearchTool = engine.runAskSearchTool;
  setModelProvider = engine.setModelProvider;
  resetModelProvider = engine.resetModelProvider;
  FakeModelProvider = testing.FakeModelProvider;
  InMemoryIndex = testing.InMemoryIndex;
});

after(() => resetModelProvider());

async function vaultWith(names) {
  const root = await mkdtemp(join(tmpdir(), "cairn-pdf-"));
  for (const name of names) await cp(join(fixtures, name), join(root, name));
  return root;
}

test("(a) section-b.pdf extracts page 3 under Section B and indexes it without a vector", async () => {
  const pages = await extractPdfPages(join(fixtures, "section-b.pdf"));
  assert.deepEqual(
    pages.map((page) => page.page),
    [1, 2, 3],
  );
  const page3 = pages.find((page) => page.page === 3);
  assert.ok(page3.text.includes(PDF_FACT));
  assert.equal(page3.text.split("\n")[0], "Section B");

  const root = await vaultWith(["section-b.pdf"]);
  try {
    const stats = await indexVault(root, { lexical: true });
    assert.equal(stats.embedded, 0);
    assert.ok(stats.chunks >= 1);
    const index = openIndex(root);
    try {
      assert.equal(index.hasVectors(), false);
      const fact = index.grepChunks("copper finch", 10);
      assert.equal(fact.length, 1);
      assert.equal(fact[0].file, "section-b.pdf");
      assert.equal(fact[0].page, 3);
      assert.equal(fact[0].heading, "Section B");
      assert.ok(fact[0].text.includes(PDF_FACT));
      const decoy = index.grepChunks("sparrows", 10);
      assert.equal(decoy.length, 1);
      assert.equal(decoy[0].page, 2);
      assert.equal(decoy[0].heading, "Section A");
    } finally {
      index.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  assert.equal(chunkNeedsEmbedding({ file: "a.pdf", page: 3, hash: "h", chunk: { text: "x", ordinal: 0, line: 1, heading: "" } }), false);
  assert.equal(chunkNeedsEmbedding({ file: "a.md", hash: "h", chunk: { text: "x", ordinal: 0, line: 1, heading: "" } }), true);

  const memory = new InMemoryIndex();
  try {
    const embedded = await embedPendingChunks(
      memory,
      [
        {
          file: "section-b.pdf",
          hash: "pdf",
          page: 3,
          chunk: { text: PDF_FACT, ordinal: 0, line: 1, heading: "Section B" },
        },
      ],
      {},
    );
    assert.equal(embedded.embedded, 0);
    assert.equal(embedded.embedder, undefined);
    assert.equal(embedded.vectors[0], null);
  } finally {
    memory.close();
  }
});

test("(b) a scanned PDF adds no chunk and a scripted invention is refused", async () => {
  const pages = await extractPdfPages(join(fixtures, "scan.pdf"));
  assert.deepEqual(pages, []);

  const root = await vaultWith(["scan.pdf"]);
  try {
    const stats = await indexVault(root, { lexical: true });
    assert.equal(stats.chunks, 0);
    const index = openIndex(root);
    try {
      assert.deepEqual(index.listFiles(), []);
    } finally {
      index.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async (_model, _messages, _tools, turn) => {
        if (turn === 1) {
          return {
            content: "",
            toolCalls: [
              { name: "read", arguments: { path: "scan.pdf" } },
              { name: "open", arguments: { path: "scan.pdf", page: 1 } },
            ],
          };
        }
        return { content: `Invented: ${PDF_FACT}`, toolCalls: [] };
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
        throw new Error("scan.pdf is not a note");
      },
      readPdf: async () => [],
      retrievalSeed: false,
    });
    assert.equal(result.stopReason, "done");
    assert.equal(result.answer, UNCOVERED);
    assert.equal(result.answer.includes("COPPER FINCH"), false);
    assert.deepEqual(result.sources, []);
    assert.deepEqual(result.opened, []);
    assert.equal(result.grounded, false);
  } finally {
    index.close();
  }
});

test("(b) a scanned PDF plus a real note keeps the note and drops the empty PDF", async () => {
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async (_model, _messages, _tools, turn) => {
        if (turn === 1) {
          return {
            content: "",
            toolCalls: [
              { name: "read", arguments: { path: "scan.pdf" } },
              { name: "read", arguments: { path: "project-heron.md" } },
            ],
          };
        }
        return { content: NOTE_FACT, toolCalls: [] };
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    const result = await runAskAgent({
      index,
      question: "What is the notebook codename?",
      mode: "lexical",
      readNote: async (path) => {
        if (path === "project-heron.md") return `# Project Heron\n\n${NOTE_FACT}\n`;
        throw new Error(`missing ${path}`);
      },
      readPdf: async (path) => {
        if (path === "scan.pdf") return [];
        throw new Error(`missing ${path}`);
      },
      retrievalSeed: false,
    });
    assert.equal(result.answer, NOTE_FACT);
    assert.equal(result.sources.some((source) => source.file === "scan.pdf"), false);
    assert.equal(result.sources.some((source) => source.file === "project-heron.md"), true);
    assert.equal(result.opened.some((anchor) => anchor.path === "scan.pdf"), false);
  } finally {
    index.close();
  }
});

test("(c) a shared codename stays on the PDF page and the note separately", async () => {
  const root = await vaultWith(["section-b.pdf", "project-heron.md", "scan.pdf"]);
  try {
    const md = discoverMarkdownFiles(root).map((abs) => abs.endsWith("project-heron.md"));
    assert.equal(md.filter(Boolean).length, 1);
    assert.equal(md.length, 1);
    const indexable = discoverIndexableFiles(root).map((abs) => basename(abs));
    assert.ok(indexable.includes("section-b.pdf"));
    assert.ok(indexable.includes("project-heron.md"));
    assert.ok(indexable.includes("scan.pdf"));

    await indexVault(root, { lexical: true });
    const index = openIndex(root);
    try {
      assert.equal(index.listFiles().includes("scan.pdf"), false);
      const state = { sources: [], opened: [] };
      const raw = await runAskSearchTool(
        "grep",
        { pattern: "COPPER FINCH" },
        { index, readNote: async () => "" },
        state,
      );
      const parsed = JSON.parse(raw);
      const pdf = parsed.matches.find((match) => match.file === "section-b.pdf");
      const note = parsed.matches.find((match) => match.file === "project-heron.md");
      assert.ok(pdf);
      assert.equal(pdf.page, 3);
      assert.equal(pdf.heading, "Section B");
      assert.ok(note);
      assert.equal(note.page, undefined);
      assert.equal(note.heading, "Project Heron");
      assert.equal(state.sources.filter((source) => source.file === "section-b.pdf").every((source) => source.page === 3), true);
      assert.equal(state.sources.some((source) => source.file === "project-heron.md" && source.page === undefined), true);
    } finally {
      index.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
