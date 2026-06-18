import assert from "node:assert/strict";
import { after, before, test } from "node:test";

let search;
let InMemoryIndex;
let originalFetch;

function vecBuf(values) {
  return Buffer.from(Float32Array.from(values).buffer);
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

before(async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/api/tags") {
      return jsonResponse({ models: [{ name: "test-embedder" }] });
    }
    if (pathname === "/api/embed") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const dim = 4;
      const vector = [1, 0, 0, 0];
      const embeddings = (body.input ?? []).map(() => vector);
      return jsonResponse({ embeddings });
    }
    return new Response("not found", { status: 404 });
  };

  const engine = await import("../dist/index.js");
  search = engine.search;
  ({ InMemoryIndex } = await import("../dist/testing.js"));
});

after(() => {
  globalThis.fetch = originalFetch;
});

test("hybrid search fuses dense and lexical arms through the Index interface", async () => {
  const index = new InMemoryIndex();
  try {
    const cacheVec = vecBuf([1, 0, 0, 0]);
    const otherVec = vecBuf([0, 1, 0, 0]);

    index.rebuildIndex({
      mode: "hybrid",
      embedder: "test-embedder",
      dim: 4,
      files: 2,
      chunks: [
        {
          id: 1,
          file: "cache.md",
          ordinal: 0,
          line: 3,
          heading: "Invalidation",
          text: "Cache invalidation is naming things and cache misses.",
          hash: "hash-cache",
          vector: cacheVec,
        },
        {
          id: 2,
          file: "bio.md",
          ordinal: 0,
          line: 1,
          heading: "Plants",
          text: "Photosynthesis converts light into chemical energy in plants.",
          hash: "hash-bio",
          vector: otherVec,
        },
      ],
    });

    const { hits, mode, coverage } = await search(index, "cache invalidation", {
      mode: "hybrid",
      k: 2,
      embedder: "test-embedder",
    });

    assert.equal(mode, "hybrid");
    assert.equal(coverage.covered, true);
    assert.ok(hits.length > 0);
    assert.equal(hits[0].file, "cache.md");
    assert.ok(hits[0].arms.includes("dense"));
  } finally {
    index.close();
  }
});
