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
  isPlainTextPath,
  isHtmlPath,
  isTablePath,
  isImagePath,
  isAudioPath,
  isVideoPath,
  isDocxPath,
  isPptxPath,
  isOfficePath,
  DOCX_NO_APP,
  PPTX_NO_APP,
  docxChipLabel,
  docxChipText,
  headingChipLabel,
  headingChipText,
  officeNoAppLine,
  officeOpenNotice,
  isReadOnlyEditorPath,
  opensInEditor,
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

test("plain text opens in the editor at a line and is not a PDF", () => {
  assert.equal(isPlainTextPath("notes/field.txt"), true);
  assert.equal(isPlainTextPath("notes/field.TXT"), true);
  assert.equal(isPlainTextPath("notes/field.md"), false);
  assert.equal(opensInEditor("notes/field.txt"), true);
  assert.equal(opensInEditor("notes/field.md"), true);
  assert.equal(opensInEditor("Notes/Readme.markdown"), true);
  assert.equal(opensInEditor("notes/field.pdf"), false);
  assert.equal(citationTitle("notes/field.txt", 9, "Section B"), "Open notes/field.txt at line 9 › Section B");
  assert.equal(citationTitle("notes/field.txt", 0), "Open notes/field.txt (file)");
});

test("html opens in the editor at a line and is not a write target", () => {
  assert.equal(isHtmlPath("notes/section-b.html"), true);
  assert.equal(isHtmlPath("notes/section-b.HTM"), true);
  assert.equal(isHtmlPath("notes/field.txt"), false);
  assert.equal(isReadOnlyEditorPath("notes/section-b.html"), true);
  assert.equal(isReadOnlyEditorPath("notes/field.txt"), true);
  assert.equal(isReadOnlyEditorPath("notes/field.md"), false);
  assert.equal(opensInEditor("notes/section-b.html"), true);
  assert.equal(opensInEditor("notes/section-b.htm"), true);
  assert.equal(citationTitle("notes/section-b.html", 9, "Section B"), "Open notes/section-b.html at line 9 › Section B");
  assert.equal(citationTitle("notes/section-b.html", 0), "Open notes/section-b.html (file)");
});

test("csv and tsv open in the editor at a line and are not a write target", () => {
  assert.equal(isTablePath("notes/section-b.csv"), true);
  assert.equal(isTablePath("notes/rows.TSV"), true);
  assert.equal(isTablePath("notes/field.txt"), false);
  assert.equal(isReadOnlyEditorPath("notes/section-b.csv"), true);
  assert.equal(isReadOnlyEditorPath("notes/rows.tsv"), true);
  assert.equal(opensInEditor("notes/section-b.csv"), true);
  assert.equal(opensInEditor("notes/rows.tsv"), true);
  assert.equal(citationTitle("notes/section-b.csv", 3), "Open notes/section-b.csv at line 3");
  assert.equal(citationTitle("notes/section-b.csv", 0), "Open notes/section-b.csv (file)");
  assert.equal(citationTitle("notes/rows.tsv", 2), "Open notes/rows.tsv at line 2");
});

test("images open in the viewer and not in the editor", () => {
  assert.equal(isImagePath("notes/section-b.png"), true);
  assert.equal(isImagePath("notes/field.JPG"), true);
  assert.equal(isImagePath("notes/field.jpeg"), true);
  assert.equal(isImagePath("notes/mark.webp"), true);
  assert.equal(isImagePath("notes/badge.GIF"), true);
  assert.equal(isImagePath("notes/clip.mp4"), false);
  assert.equal(isImagePath("notes/tone.mp3"), false);
  assert.equal(isImagePath("notes/field.md"), false);
  assert.equal(opensInEditor("notes/section-b.png"), false);
  assert.equal(opensInEditor("notes/field.jpg"), false);
  assert.equal(isReadOnlyEditorPath("notes/section-b.png"), false);
});

test("video opens in the player and not in the editor", () => {
  assert.equal(isVideoPath("notes/clip.mp4"), true);
  assert.equal(isVideoPath("notes/tone.WEBM"), true);
  assert.equal(isVideoPath("notes/section-b.mov"), true);
  assert.equal(isVideoPath("notes/clip.mkv"), false);
  assert.equal(isVideoPath("notes/clip.avi"), false);
  assert.equal(isVideoPath("notes/section-b.mp3"), false);
  assert.equal(opensInEditor("notes/clip.mp4"), false);
  assert.equal(opensInEditor("notes/tone.webm"), false);
  assert.equal(isReadOnlyEditorPath("notes/section-b.mov"), false);
});

test("audio opens in the player and not in the editor", () => {
  assert.equal(isAudioPath("notes/section-b.mp3"), true);
  assert.equal(isAudioPath("notes/tone.WAV"), true);
  assert.equal(isAudioPath("notes/clip.m4a"), true);
  assert.equal(isAudioPath("notes/clip.mp4"), false);
  assert.equal(isAudioPath("notes/section-b.png"), false);
  assert.equal(opensInEditor("notes/section-b.mp3"), false);
  assert.equal(opensInEditor("notes/tone.wav"), false);
  assert.equal(isReadOnlyEditorPath("notes/clip.m4a"), false);
});

test("a Word file chips as file.docx · heading and does not open in the editor", () => {
  assert.equal(isDocxPath("notes/field.docx"), true);
  assert.equal(isDocxPath("notes/field.DOCX"), true);
  assert.equal(isDocxPath("notes/old.doc"), false);
  assert.equal(isDocxPath("notes/macro.docm"), false);
  assert.equal(opensInEditor("notes/field.docx"), false);
  assert.equal(docxChipLabel("notes/field.docx", "第二節"), "field.docx · 第二節");
  assert.equal(docxChipLabel("notes/field.docx", "  "), "field.docx");
  assert.equal(docxChipText("notes/field.docx", "第二節", null), "field.docx · 第二節");
  assert.equal(
    docxChipText("notes/field.docx", "第二節", { file: "notes/field.docx", message: DOCX_NO_APP }),
    "No app on this computer opens .docx files.",
  );
  assert.equal(
    docxChipText("notes/other.docx", "第二節", { file: "notes/field.docx", message: DOCX_NO_APP }),
    "other.docx · 第二節",
  );
  assert.equal(citationTitle("notes/field.docx", 4, "第二節"), "Open notes/field.docx");
  assert.equal(citationTitle("notes/field.docx", 4, "第二節").includes("line"), false);
});

test("a PowerPoint file chips as deck.pptx · slide heading and does not open in the editor", () => {
  assert.equal(isPptxPath("notes/deck.pptx"), true);
  assert.equal(isPptxPath("notes/deck.PPTX"), true);
  assert.equal(isPptxPath("notes/old.ppt"), false);
  assert.equal(isPptxPath("notes/macro.pptm"), false);
  assert.equal(isPptxPath("notes/show.ppsx"), false);
  assert.equal(isPptxPath("notes/template.potx"), false);
  assert.equal(isOfficePath("notes/deck.pptx"), true);
  assert.equal(isOfficePath("notes/field.docx"), true);
  assert.equal(isOfficePath("notes/old.ppt"), false);
  assert.equal(opensInEditor("notes/deck.pptx"), false);
  const heading = "Slide 2 · 中文標題";
  assert.equal(headingChipLabel("notes/deck.pptx", heading), "deck.pptx · Slide 2 · 中文標題");
  assert.equal(headingChipLabel("notes/deck.pptx", "  "), "deck.pptx");
  assert.equal(headingChipText("notes/deck.pptx", heading, null), "deck.pptx · Slide 2 · 中文標題");
  assert.equal(
    headingChipText("notes/deck.pptx", heading, { file: "notes/deck.pptx", message: PPTX_NO_APP }),
    "No app on this computer opens .pptx files.",
  );
  assert.equal(
    headingChipText("notes/other.pptx", heading, { file: "notes/deck.pptx", message: PPTX_NO_APP }),
    "other.pptx · Slide 2 · 中文標題",
  );
  assert.equal(docxChipLabel("notes/field.docx", "第二節"), headingChipLabel("notes/field.docx", "第二節"));
  assert.equal(officeNoAppLine("notes/deck.pptx"), PPTX_NO_APP);
  assert.equal(officeNoAppLine("notes/field.docx"), DOCX_NO_APP);
  assert.equal(officeOpenNotice("deck.pptx", "No app found to open deck.pptx"), PPTX_NO_APP);
  assert.equal(officeOpenNotice("field.docx", "No app found to open field.docx"), DOCX_NO_APP);
  assert.equal(officeOpenNotice("deck.pptx", ""), PPTX_NO_APP);
  assert.equal(officeOpenNotice("deck.pptx", "File not found"), "File not found");
  assert.equal(citationTitle("notes/deck.pptx", 4, heading), "Open notes/deck.pptx");
  assert.equal(citationTitle("notes/deck.pptx", 4, heading).includes("line"), false);
});

test("vaultPathsEqual matches paths case-insensitively", () => {
  assert.equal(vaultPathsEqual("MixedCase/ReadMe.md", "mixedcase/ReadMe.md"), true);
  assert.equal(vaultPathsEqual("notes/a.md", "notes/b.md"), false);
});
