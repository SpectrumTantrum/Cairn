// Pure-logic gate for the shared citation card's formatting helpers (issue #15). The
// CitationCard React rendering itself has no harness (manual verification — see the PR
// note); this locks down the string logic reused across search results, chat pills, and
// Sources-tab rows.

import assert from "node:assert/strict";
import { test } from "node:test";

const {
  basename,
  typeChip,
  citationLineLabel,
  citationTitle,
  vaultPathsEqual,
  PDF_OPEN_LANDS_ON_PAGE,
  pdfChipLabel,
  pdfOpenTitle,
} = await import("../out-test/cite-format.js");

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
  assert.equal(
    citationTitle("project-heron.md", 21, "Section B"),
    "Open project-heron.md at line 21 › Section B",
  );
});

test("unresolved whole-file cites are labeled file, not line 1", () => {
  assert.equal(citationLineLabel(0), "file");
  assert.equal(citationLineLabel(21), "21");
  assert.equal(citationLineLabel(1), "1");
  assert.equal(citationTitle("notes/project-heron.md", 0), "Open notes/project-heron.md (file)");
  assert.equal(citationTitle("notes/project-heron.md", 0).includes("line 1"), false);
});

test("(a) a PDF chip names the page and the tooltip follows the landing switch", () => {
  assert.equal(pdfChipLabel("notes/section-b.pdf", 3), "section-b.pdf p.3");
  assert.equal(pdfChipLabel("report.pdf", 3), "report.pdf p.3");
  assert.equal(pdfOpenTitle("notes/report.pdf", 3, true), "Open notes/report.pdf at page 3");
  assert.equal(pdfOpenTitle("notes/report.pdf", 3, false), "Open notes/report.pdf");
  assert.equal(pdfOpenTitle("report.pdf", 3), pdfOpenTitle("report.pdf", 3, PDF_OPEN_LANDS_ON_PAGE));
  if (PDF_OPEN_LANDS_ON_PAGE) {
    assert.equal(citationTitle("report.pdf", 2, "Section B", 3), "Open report.pdf at page 3");
  } else {
    assert.equal(citationTitle("report.pdf", 2, "Section B", 3), "Open report.pdf");
  }
  assert.equal(citationTitle("report.pdf", 2, "Section B", 3).includes("line"), false);
  assert.equal(citationTitle("project-heron.md", 21, "Section B"), "Open project-heron.md at line 21 › Section B");
});

test("vaultPathsEqual matches paths case-insensitively", () => {
  assert.equal(vaultPathsEqual("MixedCase/ReadMe.md", "mixedcase/ReadMe.md"), true);
  assert.equal(vaultPathsEqual("notes/a.md", "notes/b.md"), false);
});
