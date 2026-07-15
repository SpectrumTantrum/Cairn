// Pure-logic gate for the shared citation card's formatting helpers (issue #15). The
// CitationCard React rendering itself has no harness (manual verification — see the PR
// note); this locks down the string logic reused across search results, chat pills, and
// Sources-tab rows.

import assert from "node:assert/strict";
import { test } from "node:test";

const { basename, typeChip, citationTitle } = await import("../out-test/cite-format.js");

test("basename returns the final path segment", () => {
  assert.equal(basename("notes/sub/file.md"), "file.md");
  assert.equal(basename("file.md"), "file.md");
  assert.equal(basename("a/b/c/deep.pdf"), "deep.pdf");
});

test("basename leaves a bare filename (no slash) unchanged", () => {
  assert.equal(basename("README"), "README");
  assert.equal(basename(""), "");
});

test("typeChip maps known extensions to short labels", () => {
  assert.equal(typeChip("a/b.md"), "MD");
  assert.equal(typeChip("a/b.pdf"), "PDF");
  assert.equal(typeChip("a/b.MP4"), "AV");
  assert.equal(typeChip("clip.webm"), "AV");
});

test("typeChip is case-insensitive on the extension", () => {
  assert.equal(typeChip("NOTE.MD"), "MD");
  assert.equal(typeChip("Paper.Pdf"), "PDF");
});

test("typeChip uppercases unknown extensions", () => {
  assert.equal(typeChip("data.csv"), "CSV");
  assert.equal(typeChip("page.html"), "HTML");
});

test("citationTitle formats the open-target hover string", () => {
  assert.equal(citationTitle("notes/a.md", 42), "Open notes/a.md at line 42");
  assert.equal(citationTitle("b.md", 1), "Open b.md at line 1");
});
