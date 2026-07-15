// Pure-logic gate for autosave-before-navigate (issue #40). Covers the exact rule that
// decides whether opening a new doc must first flush the current dirty buffer. The React
// wiring (re-entrancy guard, save-failure short-circuit) is verified manually — see the
// PR/report note — but this locks down the decision the guard is built on.

import assert from "node:assert/strict";
import { test } from "node:test";

const { pendingSaveBeforeNavigate } = await import("../out-test/editor-nav.js");

const md = (path) => ({ path, name: path, type: "markdown" });

test("dirty markdown buffer returns the pending save for the current file", () => {
  const pending = pendingSaveBeforeNavigate({
    activeNode: md("notes/a.md"),
    docKey: "notes/a.md",
    buffer: "edited",
    savedContent: "original",
  });
  assert.deepEqual(pending, { path: "notes/a.md", content: "edited" });
});

test("clean buffer returns null (no autosave when nothing is dirty)", () => {
  const pending = pendingSaveBeforeNavigate({
    activeNode: md("notes/a.md"),
    docKey: "notes/a.md",
    buffer: "same",
    savedContent: "same",
  });
  assert.equal(pending, null);
});

test("no open doc returns null", () => {
  assert.equal(
    pendingSaveBeforeNavigate({ activeNode: null, docKey: null, buffer: "", savedContent: "" }),
    null,
  );
});

test("non-markdown host returns null even if buffer differs", () => {
  // The generic read-only host (ADR-0009) has no editable buffer to lose.
  const pending = pendingSaveBeforeNavigate({
    activeNode: { path: "doc.pdf", name: "doc.pdf", type: "other" },
    docKey: null,
    buffer: "x",
    savedContent: "y",
  });
  assert.equal(pending, null);
});

test("dirty buffer but no docKey returns null (nothing bound on disk yet)", () => {
  const pending = pendingSaveBeforeNavigate({
    activeNode: md("notes/a.md"),
    docKey: null,
    buffer: "edited",
    savedContent: "original",
  });
  assert.equal(pending, null);
});

test("save targets the CURRENT node's path, not the navigation target", () => {
  // The pending save must flush the file being left, using its own current buffer.
  const pending = pendingSaveBeforeNavigate({
    activeNode: md("notes/current.md"),
    docKey: "notes/current.md",
    buffer: "unsaved work",
    savedContent: "",
  });
  assert.equal(pending?.path, "notes/current.md");
  assert.equal(pending?.content, "unsaved work");
});
