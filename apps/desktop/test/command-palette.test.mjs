// Pure-logic gate for the command palette (issue #13). Covers the filter-as-you-type match
// rule and the arrow-key active-index math (wrap-around + re-clamp when the list narrows).
// The React wiring (open chord, ARIA, focus handoff to search/composer) is verified manually
// — see the PR/report note — but this locks down the decisions the component is built on.

import assert from "node:assert/strict";
import { test } from "node:test";

const { filterCommands, commandHaystack, nextActiveIndex, clampActiveIndex } = await import(
  "../out-test/command-palette.js"
);

const CMDS = [
  { title: "Choose vault", keywords: "open switch folder" },
  { title: "Index vault", keywords: "reindex build embed search" },
  { title: "Focus search", keywords: "find lookup grep" },
  { title: "Focus Ask", keywords: "chat question compose" },
  { title: "Toggle right rail", keywords: "panel hide show" },
];

test("empty / whitespace query returns every command in order", () => {
  assert.deepEqual(filterCommands(CMDS, ""), CMDS);
  assert.deepEqual(filterCommands(CMDS, "   "), CMDS);
});

test("filter matches the title, case-insensitively", () => {
  const hits = filterCommands(CMDS, "VAULT");
  assert.deepEqual(hits.map((c) => c.title), ["Choose vault", "Index vault"]);
});

test("filter matches keywords, not just the visible title", () => {
  // "reindex" only appears in Index vault's keywords.
  const hits = filterCommands(CMDS, "reindex");
  assert.deepEqual(hits.map((c) => c.title), ["Index vault"]);
});

test("multi-term query requires every term (order-independent)", () => {
  assert.deepEqual(filterCommands(CMDS, "vault index").map((c) => c.title), ["Index vault"]);
  assert.deepEqual(filterCommands(CMDS, "index vault").map((c) => c.title), ["Index vault"]);
});

test("no match returns an empty list", () => {
  assert.deepEqual(filterCommands(CMDS, "nonexistent"), []);
});

test("commandHaystack folds title + keywords to lowercase", () => {
  assert.equal(commandHaystack({ title: "Focus Ask", keywords: "Chat" }), "focus ask chat");
  assert.equal(commandHaystack({ title: "Bare" }), "bare ");
});

test("nextActiveIndex wraps around both ends", () => {
  assert.equal(nextActiveIndex(0, 1, 5), 1);
  assert.equal(nextActiveIndex(4, 1, 5), 0); // past the end wraps to top
  assert.equal(nextActiveIndex(0, -1, 5), 4); // before the start wraps to bottom
});

test("nextActiveIndex pins at 0 for an empty list", () => {
  assert.equal(nextActiveIndex(0, 1, 0), 0);
  assert.equal(nextActiveIndex(3, -1, 0), 0);
});

test("clampActiveIndex re-clamps when the list narrows under the selection", () => {
  assert.equal(clampActiveIndex(4, 2), 1); // list shrank to 2 rows; land on the last
  assert.equal(clampActiveIndex(1, 5), 1); // still in range; unchanged
  assert.equal(clampActiveIndex(-1, 5), 0);
  assert.equal(clampActiveIndex(3, 0), 0); // empty list
});
