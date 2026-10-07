import assert from "node:assert/strict";
import { test } from "node:test";

const {
  citationsFromAskAgent,
  lineForMarkdownHeading,
  resolveCitationLine,
} = await import("../out-test/agent-citations.js");

test("citationsFromAskAgent prefers opened anchors with source snippets", () => {
  const result = {
    answer: "Done",
    sources: [
      {
        file: "notes/a.md",
        line: 12,
        heading: "Topic",
        score: 1,
        cosine: NaN,
        snippet: "key fact",
        text: "key fact in full",
        arms: "find",
      },
      {
        file: "notes/b.md",
        line: 1,
        heading: "",
        score: NaN,
        cosine: NaN,
        snippet: "",
        text: "read body",
        arms: "read",
      },
    ],
    opened: [{ path: "notes/a.md", line: 12, heading: "Topic" }],
    seedHits: [],
    steps: 2,
    stopReason: "done",
    grounded: true,
  };
  const cites = citationsFromAskAgent(result);
  assert.equal(cites.length, 2);
  assert.equal(cites[0].file, "notes/a.md");
  assert.equal(cites[0].snippet, "key fact");
  assert.equal(cites[1].file, "notes/b.md");
  assert.match(cites[1].snippet, /read body/);
});

test("lineForMarkdownHeading resolves ATX headings", () => {
  const md = "# Intro\n\n## Topic\n\nBody\n";
  assert.equal(lineForMarkdownHeading(md, "Topic"), 3);
  assert.equal(lineForMarkdownHeading(md, "Missing"), null);
});

test("citationsFromAskAgent preserves heading-only open anchors for land-at-heading", () => {
  const result = {
    answer: "See [1].",
    sources: [],
    opened: [{ path: "notes/a.md", heading: "Topic" }],
    seedHits: [],
    steps: 1,
    stopReason: "done",
    grounded: true,
  };
  const cites = citationsFromAskAgent(result);
  assert.equal(cites.length, 1);
  assert.equal(cites[0].file, "notes/a.md");
  assert.equal(cites[0].heading, "Topic");
});

test("resolveCitationLine prefers heading over line 1", () => {
  const md = "# Intro\n\n## Topic\n\nBody\n";
  assert.equal(resolveCitationLine(md, { line: 1, heading: "Topic" }), 3);
});
