import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

let engine;
let originalFetch;

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function makeVault(markdown) {
  const dir = mkdtempSync(join(tmpdir(), "cairn-engine-smoke-"));
  writeFileSync(join(dir, "note.md"), markdown);
  return dir;
}

before(async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/api/tags") {
      return jsonResponse({ models: [{ name: "qwen3:4b" }] });
    }
    if (pathname === "/api/chat") {
      return jsonResponse({
        message: {
          content: "Cairn keeps Markdown vaults local and cites source lines [1].",
        },
      });
    }
    return new Response("not found", { status: 404 });
  };
  engine = await import("../dist/index.js");
});

after(() => {
  globalThis.fetch = originalFetch;
});

test("Qwen3 query embeddings use the asymmetric instruction prefix", async () => {
  const { formatQueryForEmbedding } = await import("../dist/embed.js");
  const query = "cache invalidation";

  assert.equal(formatQueryForEmbedding("nomic-embed-text", query), query);
  assert.match(
    formatQueryForEmbedding("qwen3-embedding:0.6b", query),
    /^Instruct: Given a question, retrieve relevant passages from the user's notes that best answer it\.\nQuery: cache invalidation$/,
  );
});

test("Ask refuses when lexical retrieval finds no support", async () => {
  const vault = makeVault("# Vault\n\nCairn indexes local Markdown notes with file and line citations.");
  try {
    await engine.indexVault(vault, { lexical: true });
    const index = engine.openIndex(vault);
    try {
      const result = await engine.ask(index, "photosynthesis enzymes", { mode: "lexical" });
      assert.equal(result.grounded, false);
      assert.equal(result.covered, false);
      assert.equal(result.sources.length, 0);
      assert.match(result.reason, /coverage threshold/i);
      assert.match(result.answer, /don't cover/i);
    } finally {
      index.close();
    }
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("Ask returns supported answers with citations when retrieval is covered", async () => {
  const vault = makeVault(
    "# Local vault\n\nCairn keeps Markdown vaults local and cites source lines for grounded answers.",
  );
  try {
    await engine.indexVault(vault, { lexical: true });
    const index = engine.openIndex(vault);
    try {
      const result = await engine.ask(index, "What does Cairn keep local?", { mode: "lexical" });
      assert.equal(result.grounded, true);
      assert.equal(result.covered, true);
      assert.ok(result.sources.length > 0);
      assert.match(result.answer, /\[1\]/);
      assert.equal(result.model, "qwen3:4b");
    } finally {
      index.close();
    }
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
