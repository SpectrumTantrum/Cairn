import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

let ask;
let openIndex;
let setModelProvider;
let resetModelProvider;
let FakeModelProvider;
let InMemoryIndex;

function vecBuf(values) {
  return Buffer.from(Float32Array.from(values).buffer);
}

function makeVault(markdown) {
  const dir = mkdtempSync(join(tmpdir(), "cairn-ask-hybrid-"));
  writeFileSync(join(dir, "note.md"), markdown);
  return dir;
}

before(async () => {
  const engine = await import("../dist/index.js");
  const testing = await import("../dist/testing.js");
  ask = engine.ask;
  openIndex = engine.openIndex;
  setModelProvider = engine.setModelProvider;
  resetModelProvider = engine.resetModelProvider;
  FakeModelProvider = testing.FakeModelProvider;
  InMemoryIndex = testing.InMemoryIndex;

  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b", "test-embedder"],
      embed: (_model, input) => Promise.resolve(input.map(() => [1, 0, 0, 0])),
      chat: () => Promise.resolve("Local vaults stay on disk with citations [1]."),
    }),
  );
});

after(() => {
  resetModelProvider();
});

test("ask refuses hybrid ask when coverage threshold is not met", async () => {
  const index = new InMemoryIndex();
  try {
    index.rebuildIndex({
      mode: "hybrid",
      embedder: "test-embedder",
      dim: 4,
      files: 1,
      chunks: [
        {
          id: 1,
          file: "note.md",
          ordinal: 0,
          line: 1,
          heading: "",
          text: "Unrelated botany notes about chloroplast membranes.",
          hash: "h1",
          vector: vecBuf([0, 1, 0, 0]),
        },
      ],
    });

    const result = await ask(index, "cache invalidation", { mode: "hybrid", coverageThreshold: 0.9 });
    assert.equal(result.covered, false);
    assert.equal(result.grounded, false);
    assert.match(result.answer, /don't cover/i);
  } finally {
    index.close();
  }
});

test("ask returns grounded hybrid answers when retrieval is covered", async () => {
  const vault = makeVault("# Notes\n\nCache invalidation is naming things.");
  try {
    await import("../dist/index.js").then((engine) => engine.indexVault(vault, { lexical: true }));
    const index = openIndex(vault);
    try {
      const result = await ask(index, "What is cache invalidation?", { mode: "lexical" });
      assert.equal(result.covered, true);
      assert.equal(result.grounded, true);
      assert.ok(result.sources.length > 0);
      assert.match(result.answer, /\[1\]/);
    } finally {
      index.close();
    }
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
