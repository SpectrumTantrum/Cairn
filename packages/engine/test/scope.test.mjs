import assert from "node:assert/strict";
import { after, before, test } from "node:test";

let search;
let ask;
let setModelProvider;
let resetModelProvider;
let FakeModelProvider;
let InMemoryIndex;

function vecBuf(values) {
  return Buffer.from(Float32Array.from(values).buffer);
}

// Three chunks in three files. Dense-wise, a.md is the closest match to the query
// vector, b.md next, c.md orthogonal. FTS-wise all three contain "local".
function seed(index) {
  index.rebuildIndex({
    mode: "hybrid",
    embedder: "test-embedder",
    dim: 4,
    files: 3,
    chunks: [
      { id: 1, file: "a.md", ordinal: 0, line: 1, heading: "", text: "local vault alpha", hash: "h1", vector: vecBuf([1, 0, 0, 0]) },
      { id: 2, file: "b.md", ordinal: 0, line: 1, heading: "", text: "local vault bravo", hash: "h2", vector: vecBuf([0.92, 0.1, 0, 0]) },
      { id: 3, file: "c.md", ordinal: 0, line: 1, heading: "", text: "local vault charlie", hash: "h3", vector: vecBuf([0, 1, 0, 0]) },
    ],
  });
}

before(async () => {
  const engine = await import("../dist/index.js");
  const testing = await import("../dist/testing.js");
  search = engine.search;
  ask = engine.ask;
  setModelProvider = engine.setModelProvider;
  resetModelProvider = engine.resetModelProvider;
  FakeModelProvider = testing.FakeModelProvider;
  InMemoryIndex = testing.InMemoryIndex;

  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b", "test-embedder"],
      embed: (_model, input) => Promise.resolve(input.map(() => [1, 0, 0, 0])),
      chat: () => Promise.resolve("Scoped answer from your notes [1]."),
    }),
  );
});

after(() => {
  resetModelProvider();
});

test("hybrid scope restricts results to the include-list and does not starve top-k", async () => {
  const index = new InMemoryIndex();
  try {
    seed(index);
    // a.md is the strongest dense hit; scoping to b.md must still return b.md at k=1,
    // proving enforcement happens on the full ranked pool, not by trimming an
    // already-truncated top-k (which would have surfaced a.md then dropped it -> empty).
    const { hits } = await search(index, "local vault", { k: 1, mode: "hybrid", scope: ["b.md"] });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].file, "b.md");
  } finally {
    index.close();
  }
});

test("hybrid scope with multiple files keeps only in-scope sources", async () => {
  const index = new InMemoryIndex();
  try {
    seed(index);
    const { hits } = await search(index, "local vault", { k: 8, mode: "hybrid", scope: ["a.md", "c.md"] });
    const files = new Set(hits.map((h) => h.file));
    assert.ok(files.has("a.md"));
    assert.ok(!files.has("b.md"));
  } finally {
    index.close();
  }
});

test("lexical scope restricts keyword results", async () => {
  const index = new InMemoryIndex();
  try {
    seed(index);
    const { hits, mode } = await search(index, "local vault", { k: 8, mode: "lexical", scope: ["c.md"] });
    assert.equal(mode, "lexical");
    assert.ok(hits.length > 0);
    assert.ok(hits.every((h) => h.file === "c.md"));
  } finally {
    index.close();
  }
});

test("omitted scope searches the whole index (backward compatible)", async () => {
  const index = new InMemoryIndex();
  try {
    seed(index);
    const { hits } = await search(index, "local vault", { k: 8, mode: "hybrid" });
    assert.ok(hits.length >= 3);
  } finally {
    index.close();
  }
});

test("empty scope array is treated as no scope", async () => {
  const index = new InMemoryIndex();
  try {
    seed(index);
    const { hits } = await search(index, "local vault", { k: 8, mode: "hybrid", scope: [] });
    assert.ok(hits.length >= 3);
  } finally {
    index.close();
  }
});

test("ask() honors scope and refuses when the scoped subset lacks coverage", async () => {
  const index = new InMemoryIndex();
  try {
    seed(index);
    // Scope to c.md only; its vector is orthogonal to the query, so poolMaxCosine
    // (computed on the scoped subset) falls under the threshold -> refusal.
    const refused = await ask(index, "local vault", { k: 4, mode: "hybrid", scope: ["c.md"], coverageThreshold: 0.5 });
    assert.equal(refused.covered, false);
    assert.match(refused.answer, /don't cover/i);

    const covered = await ask(index, "local vault", { k: 4, mode: "hybrid", scope: ["a.md"], coverageThreshold: 0.5 });
    assert.equal(covered.covered, true);
    assert.ok(covered.sources.every((s) => s.file === "a.md"));
  } finally {
    index.close();
  }
});
