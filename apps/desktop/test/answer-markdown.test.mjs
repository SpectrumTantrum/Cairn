// Emphasis in answer prose. Chips are split first; this file checks that
// `**bold**` does not survive as literal asterisks, and that a `[path:line]`
// chip still splits out of the same sentence.

import assert from "node:assert/strict";
import { test } from "node:test";

const { answerMarkdownRuns } = await import("../out-test/answer-markdown.js");
const { splitInlineCites } = await import("../out-test/agent-citations.js");

function visible(source) {
  return answerMarkdownRuns(source)
    .map((run) => run.text)
    .join("");
}

test("**bold** is a strong run and the asterisks are gone", () => {
  const runs = answerMarkdownRuns("The code is **COPPER FINCH**.");
  assert.deepEqual(runs, [
    { kind: "text", text: "The code is " },
    { kind: "strong", text: "COPPER FINCH" },
    { kind: "text", text: "." },
  ]);
  assert.equal(visible("The code is **COPPER FINCH**.").includes("**"), false);
});

test("__bold__ and *italic* render, and plain text is unchanged", () => {
  assert.deepEqual(answerMarkdownRuns("Use __bold__ and *italic* here."), [
    { kind: "text", text: "Use " },
    { kind: "strong", text: "bold" },
    { kind: "text", text: " and " },
    { kind: "em", text: "italic" },
    { kind: "text", text: " here." },
  ]);
  assert.deepEqual(answerMarkdownRuns("Hello"), [{ kind: "text", text: "Hello" }]);
  assert.deepEqual(answerMarkdownRuns("2 * 3"), [{ kind: "text", text: "2 * 3" }]);
});

test("an inline citation chip survives beside bold", () => {
  const hit = {
    file: "project-heron.md",
    line: 21,
    heading: "Section B",
    score: NaN,
    cosine: NaN,
    snippet: "fact",
    text: "fact",
    arms: "read",
  };
  const segments = splitInlineCites("See **fact** [project-heron.md:21] now", [hit]);
  const cites = segments.filter((segment) => segment.kind === "cite");
  assert.equal(cites.length, 1);
  assert.equal(cites[0].hit, hit);
  const prose = segments
    .filter((segment) => segment.kind === "text")
    .flatMap((segment) => answerMarkdownRuns(segment.text));
  assert.equal(prose.some((run) => run.kind === "strong" && run.text === "fact"), true);
  assert.equal(prose.map((run) => run.text).join("").includes("**"), false);
  assert.equal(prose.map((run) => run.text).join("").includes("[project-heron.md:21]"), false);
});

test("asterisks wrapped around a citation chip are removed", () => {
  const hit = {
    file: "project-heron.md",
    line: 21,
    heading: "Section B",
    score: NaN,
    cosine: NaN,
    snippet: "fact",
    text: "fact",
    arms: "read",
  };
  const segments = splitInlineCites("**[project-heron.md:21]**", [hit]);
  assert.equal(segments.some((segment) => segment.kind === "cite"), true);
  const prose = segments
    .filter((segment) => segment.kind === "text")
    .flatMap((segment) => answerMarkdownRuns(segment.text));
  assert.equal(prose.map((run) => run.text).join("").includes("*"), false);
});
