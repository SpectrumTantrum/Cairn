import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const { discoverMarkdownFiles, chunkVaultFiles } = await import("../dist/indexer.js");

test("discoverMarkdownFiles skips hidden and non-markdown paths", () => {
  const root = mkdtempSync(join(tmpdir(), "cairn-reindex-"));
  try {
    writeFileSync(join(root, "note.md"), "# A");
    writeFileSync(join(root, "skip.txt"), "nope");
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "ref");

    const files = discoverMarkdownFiles(root);
    assert.equal(files.length, 1);
    assert.match(files[0], /note\.md$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("chunkVaultFiles preserves vault-relative paths and provenance", async () => {
  const root = mkdtempSync(join(tmpdir(), "cairn-reindex-"));
  try {
    writeFileSync(join(root, "note.md"), "# Title\n\nBody text.");
    const files = discoverMarkdownFiles(root);
    const pending = await chunkVaultFiles(root, files);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].file, "note.md");
    assert.match(pending[0].chunk.text, /Body text/);
    assert.ok(pending[0].hash.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
