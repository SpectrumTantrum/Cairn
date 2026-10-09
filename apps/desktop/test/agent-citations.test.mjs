import assert from "node:assert/strict";
import { test } from "node:test";

const {
  citationLandingLine,
  citationsFromAskAgent,
  lineForMarkdownHeading,
  resolveCitationLine,
  splitInlineCites,
} = await import("../out-test/agent-citations.js");
const { FILE_CITE_LINE, citationLineLabel, citationTitle, pdfChipLabel, pdfOpenTitle, PDF_OPEN_LANDS_ON_PAGE } =
  await import("../out-test/cite-format.js");

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
  assert.equal(cites.length, 1);
  assert.equal(cites[0].file, "notes/a.md");
  assert.equal(cites[0].snippet, "key fact");
  assert.equal(cites.some((c) => c.file === "notes/b.md"), false);
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

test("lineForMarkdownHeading handles CRLF and closing hashes", () => {
  const md = "# Intro\r\n\r\n## Topic ##\r\n\r\nBody\r\n";
  assert.equal(lineForMarkdownHeading(md, "Topic"), 3);
});

// QA fixtures: clean vault has "## Section A" at Ln 13 and the fact under "## Section B"
// at Ln 21. Messy vault has "## Section 2" at Ln 13 (heading search). Keys are 1-based lines.
function linesToNote(entries) {
  const last = Math.max(...Object.keys(entries).map((n) => Number(n)));
  const lines = Array.from({ length: last }, () => "");
  for (const [line, text] of Object.entries(entries)) lines[Number(line) - 1] = text;
  return lines.join("\n");
}

function fileStartSnippet(content, max = 160) {
  const t = content.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function readHit(file, content) {
  return {
    file,
    line: 1,
    heading: "",
    score: NaN,
    cosine: NaN,
    snippet: fileStartSnippet(content),
    text: content,
    arms: "read",
  };
}

const CLEAN_FACT = "The cited fact is that citation chips must carry the enclosing heading line.";

const cleanNote = linesToNote({
  1: "# Clean vault",
  3: "Notes for the agentic Ask citation check.",
  5: "Preamble before the first section.",
  6: "The note continues with context that is not the fact.",
  7: "Still before any heading.",
  9: "More preamble so the sections land on the QA lines.",
  10: "Line ten is still preamble.",
  11: "Line eleven is still preamble.",
  13: "## Section A",
  15: "Section A is an earlier draft about opening the first line.",
  16: "The inline pointer often lands here by mistake.",
  17: "This section does not hold the cited fact.",
  19: "Still inside Section A.",
  21: "## Section B",
  23: CLEAN_FACT,
});

const messyNote = linesToNote({
  1: "# ReadMe",
  3: "A messy note with uneven headings and a long preamble.",
  5: "Intro fluff before any real section.",
  6: "Still the top of the file, which is what a whole-file read snippet shows.",
  8: "## Section 1",
  10: "First section is a decoy.",
  11: "Not the heading-search target.",
  13: "## Section 2",
  15: "Section two holds the heading-search target passage.",
});

const agentShell = {
  seedHits: [],
  steps: 1,
  stopReason: "done",
  grounded: true,
};

test("whole-file read cites the enclosing heading of the fact, not line 1", () => {
  assert.equal(lineForMarkdownHeading(cleanNote, "Section A"), 13);
  assert.equal(lineForMarkdownHeading(cleanNote, "Section B"), 21);
  const source = readHit("notes/clean.md", cleanNote);
  assert.equal(source.snippet.includes("enclosing heading line"), false);
  const result = {
    answer:
      "The inline cite pointed at [notes/clean.md:13] (Section A), but the note states the cited fact is that citation chips must carry the enclosing heading line.",
    sources: [source],
    opened: [],
    ...agentShell,
  };
  const cites = citationsFromAskAgent(result);
  assert.equal(cites.length, 1);
  assert.equal(cites[0].line, 21);
  assert.equal(cites[0].heading, "Section B");
  assert.match(cites[0].snippet, /enclosing heading line/);
  assert.doesNotMatch(cites[0].snippet, /Notes for the agentic Ask citation check/);
  // Tooltip uses hit.line; click uses resolveCitationLine. They must be the same line.
  assert.equal(resolveCitationLine(cleanNote, cites[0]), cites[0].line);
});

test("whole-file read ignores a wrong Section A anchor when the fact is under Section B", () => {
  const result = {
    answer:
      'The model opened line 13, but quoted "The cited fact is that citation chips must carry the enclosing heading line."',
    sources: [readHit("notes/clean.md", cleanNote)],
    opened: [{ path: "notes/clean.md", line: 13, heading: "Section A" }],
    ...agentShell,
  };
  const cites = citationsFromAskAgent(result);
  assert.equal(cites.length, 1);
  assert.equal(cites[0].line, 21);
  assert.equal(cites[0].heading, "Section B");
  assert.match(cites[0].snippet, /enclosing heading line/);
  assert.doesNotMatch(cites[0].snippet, /Notes for the agentic Ask citation check/);
  assert.equal(resolveCitationLine(cleanNote, cites[0]), 21);
});

test("heading search still lands on Section 2 at line 13", () => {
  assert.equal(lineForMarkdownHeading(messyNote, "Section 2"), 13);
  const sectionTwo = "Section two holds the heading-search target passage.";
  const file = "MixedCase/ReadMe.md";
  const result = {
    answer: "See [1]. First section is a decoy.",
    sources: [
      readHit(file, messyNote),
      {
        file,
        line: 13,
        heading: "Section 2",
        score: 1,
        cosine: NaN,
        snippet: sectionTwo,
        text: sectionTwo,
        arms: "find",
      },
    ],
    opened: [{ path: file, heading: "Section 2" }],
    ...agentShell,
    steps: 2,
  };
  const cites = citationsFromAskAgent(result);
  assert.equal(cites[0].line, 13);
  assert.equal(cites[0].heading, "Section 2");
  assert.equal(cites[0].snippet, sectionTwo);
  assert.equal(resolveCitationLine(messyNote, cites[0]), 13);
  const readCite = cites.find((c) => c.arms === "read");
  assert.ok(readCite);
  assert.equal(readCite.line, lineForMarkdownHeading(messyNote, "Section 1"));
  assert.equal(readCite.heading, "Section 1");
});

test("whole-file read with no passage match is labeled file and opens at the top", () => {
  const source = readHit("notes/clean.md", cleanNote);
  const result = {
    answer: "Bananas telescope through purple widgets overnight. See [notes/clean.md:1].",
    sources: [source],
    opened: [],
    ...agentShell,
  };
  const cites = citationsFromAskAgent(result);
  assert.equal(cites.length, 1);
  assert.equal(cites[0].line, FILE_CITE_LINE);
  assert.equal(cites[0].heading, "");
  assert.equal(cites[0].snippet, source.snippet);
  assert.equal(citationLineLabel(cites[0].line), "file");
  assert.equal(citationTitle(cites[0].file, cites[0].line), "Open notes/clean.md (file)");
  assert.equal(resolveCitationLine(cleanNote, cites[0]), 1);
});

test("whole-file read with no heading falls back to the matched fact line", () => {
  const plain = [
    "Alpha sentence without a heading marker.",
    "Just prose in the middle.",
    "",
    "The orphan fact lives on this exact line.",
  ].join("\n");
  const result = {
    answer: "The orphan fact lives on this exact line.",
    sources: [readHit("notes/plain.md", plain)],
    opened: [],
    ...agentShell,
  };
  const cites = citationsFromAskAgent(result);
  assert.equal(cites.length, 1);
  assert.equal(cites[0].line, 4);
  assert.equal(cites[0].heading, "");
  assert.match(cites[0].snippet, /orphan fact lives/);
  assert.equal(resolveCitationLine(plain, cites[0]), 4);
});

test("citationsFromAskAgent matches find hits for heading-only opens (not read() line 1)", () => {
  const result = {
    answer: "See [1].",
    sources: [
      {
        file: "ReadMe.md",
        line: 1,
        heading: "",
        score: NaN,
        cosine: NaN,
        snippet: "whole file",
        text: "whole file",
        arms: "read",
      },
      {
        file: "ReadMe.md",
        line: 13,
        heading: "Section 2",
        score: 1,
        cosine: NaN,
        snippet: "section two",
        text: "section two body",
        arms: "find",
      },
    ],
    opened: [{ path: "ReadMe.md", heading: "Section 2" }],
    seedHits: [],
    steps: 2,
    stopReason: "done",
    grounded: true,
  };
  const cites = citationsFromAskAgent(result);
  assert.equal(cites[0].line, 13);
  assert.equal(cites[0].heading, "Section 2");
});

test("drops the unresolved whole-file chip when the same file has a heading chip", () => {
  const read = readHit("notes/project-heron.md", cleanNote);
  const result = {
    answer: "Bananas telescope through purple widgets overnight.",
    sources: [
      read,
      {
        file: "notes/project-heron.md",
        line: 21,
        heading: "Section B",
        score: 1,
        cosine: NaN,
        snippet: CLEAN_FACT,
        text: CLEAN_FACT,
        arms: "find",
      },
    ],
    opened: [{ path: "notes/project-heron.md", line: 21, heading: "Section B" }],
    ...agentShell,
  };
  const cites = citationsFromAskAgent(result);
  assert.equal(cites.length, 1);
  assert.equal(cites[0].file, "notes/project-heron.md");
  assert.equal(cites[0].line, 21);
  assert.equal(cites[0].heading, "Section B");
  assert.equal(cites[0].snippet, CLEAN_FACT);
  assert.equal(
    cites.some((c) => c.line === FILE_CITE_LINE || (c.line === 1 && c.snippet === read.snippet)),
    false,
  );
});

test("collapses duplicate unresolved reads of one file into a single file chip", () => {
  const read = readHit("notes/project-heron.md", cleanNote);
  const again = { ...read, snippet: "second copy of the file start" };
  const result = {
    answer: "Bananas telescope through purple widgets overnight. See [notes/project-heron.md:1].",
    sources: [read, again],
    opened: [],
    ...agentShell,
  };
  const cites = citationsFromAskAgent(result);
  assert.equal(cites.length, 1);
  assert.equal(cites[0].line, FILE_CITE_LINE);
  assert.equal(citationLineLabel(cites[0].line), "file");
  assert.equal(resolveCitationLine(cleanNote, cites[0]), 1);
});

test("a line-1 find hit stays line 1", () => {
  const result = {
    answer: "opens at the top",
    sources: [
      {
        file: "notes/top.md",
        line: 1,
        heading: "",
        score: 1,
        cosine: NaN,
        snippet: "opens at the top",
        text: "opens at the top",
        arms: "find",
      },
    ],
    opened: [],
    ...agentShell,
  };
  const cites = citationsFromAskAgent(result);
  assert.equal(cites.length, 1);
  assert.equal(cites[0].line, 1);
  assert.equal(citationLineLabel(cites[0].line), "1");
  assert.equal(citationTitle(cites[0].file, cites[0].line), "Open notes/top.md at line 1");
});

function flattenCites(segments) {
  return segments.map((s) => (s.kind === "text" ? s.text : `{${s.hit.line}:${s.hit.heading}}`)).join("");
}

test("inline [path:line] becomes the resolved chip and unknown cites are stripped", () => {
  const heron = {
    file: "notes/project-heron.md",
    line: 21,
    heading: "Section B",
    score: 1,
    cosine: NaN,
    snippet: CLEAN_FACT,
    text: CLEAN_FACT,
    arms: "find",
  };
  const fileChip = {
    ...heron,
    line: FILE_CITE_LINE,
    heading: "",
    snippet: "top of the file",
    arms: "read",
  };
  const answer =
    "The fact is under [project-heron.md:12] in the note. Also [other.md:3] and see [1].";
  const segments = splitInlineCites(answer, [fileChip, heron]);
  const chips = segments.filter((s) => s.kind === "cite");
  assert.equal(chips.length, 1);
  assert.equal(chips[0].hit.line, 21);
  assert.equal(chips[0].hit.heading, "Section B");
  assert.equal(chips[0].hit, heron);
  const text = segments
    .filter((s) => s.kind === "text")
    .map((s) => s.text)
    .join("");
  assert.equal(text.includes("[project-heron.md:12]"), false);
  assert.equal(text.includes("[other.md:3]"), false);
  assert.match(text, /\[1\]/);
  assert.equal(flattenCites(segments), "The fact is under {21:Section B} in the note. Also and see [1].");
});

test("inline cite follows a whole-file read that resolved to Section B", () => {
  const answer =
    "The cited fact is that citation chips must carry the enclosing heading line. See [project-heron.md:12].";
  const cites = citationsFromAskAgent({
    answer,
    sources: [readHit("notes/project-heron.md", cleanNote)],
    opened: [],
    ...agentShell,
  });
  assert.equal(cites.length, 1);
  assert.equal(cites[0].line, 21);
  assert.equal(cites[0].heading, "Section B");
  assert.equal(
    flattenCites(splitInlineCites(answer, cites)),
    "The cited fact is that citation chips must carry the enclosing heading line. See {21:Section B}.",
  );
});

test("inline cite keeps a lone file chip when nothing resolved a passage", () => {
  const fileChip = {
    file: "notes/project-heron.md",
    line: FILE_CITE_LINE,
    heading: "",
    score: NaN,
    cosine: NaN,
    snippet: "top of the file",
    text: "top of the file",
    arms: "read",
  };
  const segments = splitInlineCites("See [Notes/Project-Heron.md:12].", [fileChip]);
  const chips = segments.filter((s) => s.kind === "cite");
  assert.equal(chips.length, 1);
  assert.equal(chips[0].hit, fileChip);
  assert.equal(citationLineLabel(chips[0].hit.line), "file");
  assert.equal(flattenCites(segments), "See {0:}.");
});

test("clean vault cite of project-heron.md:12 keeps one Section B chip at line 21", () => {
  const read = readHit("project-heron.md", cleanNote);
  const top = {
    ...read,
    arms: "dense+fts",
    text: cleanNote.split("\n").slice(0, 12).join("\n"),
  };
  const sectionB = {
    file: "project-heron.md",
    line: 21,
    heading: "Section B",
    score: 1,
    cosine: NaN,
    snippet: CLEAN_FACT,
    text: CLEAN_FACT,
    arms: "dense+fts",
  };
  const answer = `See [project-heron.md:12]. ${CLEAN_FACT}`;
  const cites = citationsFromAskAgent({
    answer,
    sources: [top, sectionB, read],
    opened: [{ path: "project-heron.md", line: 12 }],
    ...agentShell,
  });
  assert.equal(cites.length, 1);
  assert.equal(cites[0].file, "project-heron.md");
  assert.equal(cites[0].line, 21);
  assert.equal(cites[0].heading, "Section B");
  assert.match(cites[0].snippet, /enclosing heading line/);
  assert.equal(cites[0].snippet.includes("Notes for the agentic Ask citation check"), false);
  const segments = splitInlineCites(answer, cites);
  const chips = segments.filter((s) => s.kind === "cite");
  assert.equal(chips.length, 1);
  assert.equal(chips[0].hit, cites[0]);
  assert.equal(chips[0].hit.line, 21);
  assert.equal(chips[0].hit.heading, "Section B");
  assert.equal(
    segments.map((s) => (s.kind === "text" ? s.text : "")).join("").includes("[project-heron.md:12]"),
    false,
  );
  assert.equal(flattenCites(segments), `See {21:Section B}. ${CLEAN_FACT}`);
});

test("reads the answer does not cite or match get no chip", () => {
  const files = ["meeting-notes.md", "reading-list.md", "recipes.md"];
  const cites = citationsFromAskAgent({
    answer: "Bananas telescope through purple widgets overnight.",
    sources: files.map((file) =>
      readHit(file, `# ${file}\n\nBody that does not overlap the answer at all.\n`),
    ),
    opened: [],
    ...agentShell,
  });
  assert.equal(cites.length, 0);
});

test("ambiguous basename inline cites are stripped and full paths still match", () => {
  const a = {
    file: "a/project-heron.md",
    line: 4,
    heading: "",
    score: 1,
    cosine: NaN,
    snippet: "alpha",
    text: "alpha",
    arms: "find",
  };
  const b = {
    file: "b/project-heron.md",
    line: 9,
    heading: "Other",
    score: 1,
    cosine: NaN,
    snippet: "beta",
    text: "beta",
    arms: "find",
  };
  assert.equal(flattenCites(splitInlineCites("See [project-heron.md:12] now.", [a, b])), "See now.");
  assert.equal(flattenCites(splitInlineCites("See [a/project-heron.md:12] now.", [a, b])), "See {4:} now.");
  assert.equal(
    flattenCites(splitInlineCites("[missing.md:1] starts", [])),
    "starts",
  );
  assert.equal(flattenCites(splitInlineCites("ends [missing.md:3]", [])), "ends");
});

const { runAskSearchTool } = await import("@cairn/engine");
const { InMemoryIndex } = await import("@cairn/engine/testing");
const { chunkMarkdown } = await import("../../../packages/engine/dist/chunk.js");

const TERSE_ANSWER = "COPPER FINCH, 312";
const PARAPHRASE_ANSWER = "The codename is COPPER FINCH and the number is 312.";

const heronForGrep = linesToNote({
  1: "# Project Heron",
  3: "Status notes for the heron effort.",
  5: "Preamble before either section.",
  13: "## Section A",
  15: "Earlier draft. The working name was still unset.",
  21: "## Section B",
  23: "The unique cairn-alpha phrase is COPPER FINCH, 312.",
});

async function indexedHeron() {
  const chunks = await chunkMarkdown(heronForGrep);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].line, 1);
  const index = new InMemoryIndex();
  index.rebuildIndex({
    mode: "lexical",
    files: 1,
    chunks: [
      {
        id: 1,
        file: "project-heron.md",
        ordinal: chunks[0].ordinal,
        line: chunks[0].line,
        heading: chunks[0].heading,
        text: chunks[0].text,
        hash: "heron",
      },
    ],
  });
  return { index, chunkHeading: chunks[0].heading };
}

async function searchThenMaybeGrepThenRead(grep) {
  const { index, chunkHeading } = await indexedHeron();
  try {
    const state = { sources: [], opened: [] };
    const ctx = {
      index,
      readNote: async (path) => {
        if (path !== "project-heron.md") throw new Error(`missing ${path}`);
        return heronForGrep;
      },
      defaultMode: "lexical",
    };
    await runAskSearchTool("find", { query: "COPPER FINCH", k: 4 }, ctx, state);
    if (grep) {
      const reported = JSON.parse(
        await runAskSearchTool("grep", { pattern: "Section B" }, ctx, state),
      );
      assert.equal(reported.matches[0].file, "project-heron.md");
      assert.equal(reported.matches[0].line, 21);
      assert.equal(reported.matches[0].heading, "Section B");
      const findHit = state.sources.find((s) => s.arms === "fts");
      const grepHit = state.sources.find((s) => s.arms === "grep");
      assert.ok(findHit);
      assert.ok(grepHit);
      assert.equal(findHit.line, 1);
      assert.equal(findHit.heading, chunkHeading);
      assert.notEqual(
        `${findHit.file}:${findHit.line}:${findHit.heading}`,
        `${grepHit.file}:${grepHit.line}:${grepHit.heading}`,
      );
    }
    await runAskSearchTool("read", { path: "project-heron.md" }, ctx, state);
    return state;
  } finally {
    index.close();
  }
}

function heronChips(answer, state) {
  return citationsFromAskAgent({
    answer,
    sources: state.sources,
    opened: state.opened,
    ...agentShell,
  }).filter((hit) => hit.file === "project-heron.md");
}

test("find, grep Section B, then read cites project-heron at line 21 for a terse answer", async () => {
  const state = await searchThenMaybeGrepThenRead(true);
  const cites = heronChips(TERSE_ANSWER, state);
  assert.equal(cites.length, 1);
  assert.equal(cites[0].line, 21);
  assert.equal(cites[0].heading, "Section B");
  assert.equal(cites[0].arms, "grep");
  assert.equal(citationLineLabel(cites[0].line), "21");
  assert.equal(citationLandingLine(cites[0]), resolveCitationLine(heronForGrep, cites[0]));
  assert.equal(
    citationTitle(cites[0].file, citationLandingLine(cites[0]), cites[0].heading),
    "Open project-heron.md at line 21 › Section B",
  );
  assert.equal(resolveCitationLine(heronForGrep, cites[0]), 21);
});

test("find, grep Section B, then read keeps the line-21 chip for a paraphrase", async () => {
  const state = await searchThenMaybeGrepThenRead(true);
  const cites = heronChips(PARAPHRASE_ANSWER, state);
  assert.equal(cites.length, 1);
  assert.equal(cites[0].line, 21);
  assert.equal(cites[0].heading, "Section B");
  assert.equal(citationLineLabel(cites[0].line), "21");
  assert.equal(resolveCitationLine(heronForGrep, cites[0]), 21);
});

test("find then read with a short answer shows no chip when nothing was grepped", async () => {
  // Three words cannot pass the 4-word matcher, and the answer cites no path.
  // Without a located grep hit there is nothing for a chip to point at.
  const state = await searchThenMaybeGrepThenRead(false);
  const cites = heronChips(TERSE_ANSWER, state);
  assert.equal(cites.length, 0);
});

test("citation tooltip line equals the click target line", () => {
  const note = linesToNote({
    1: "# Project Heron",
    21: "## Section B",
    25: CLEAN_FACT,
  });
  const hit = {
    file: "project-heron.md",
    line: 25,
    heading: "Section B",
    score: NaN,
    cosine: NaN,
    snippet: CLEAN_FACT,
    text: note,
    arms: "grep",
  };
  const click = resolveCitationLine(note, hit);
  const landing = citationLandingLine(hit);
  assert.equal(click, 21);
  assert.equal(landing, click);
  assert.equal(citationLineLabel(landing), "21");
  assert.equal(citationTitle(hit.file, landing, hit.heading), "Open project-heron.md at line 21 › Section B");
});

test("an unused search hit gets no chip", () => {
  const cites = citationsFromAskAgent({
    answer: CLEAN_FACT,
    sources: [
      readHit("notes/clean.md", cleanNote),
      {
        file: "notes/recipes.md",
        line: 8,
        heading: "Soup",
        score: 1,
        cosine: NaN,
        snippet: "Bake the bread slowly until the crust is set.",
        text: "Bake the bread slowly until the crust is set.",
        arms: "find",
      },
    ],
    opened: [],
    ...agentShell,
  });
  assert.equal(cites.some((c) => c.file === "notes/recipes.md"), false);
  assert.equal(cites.length, 1);
  assert.equal(cites[0].file, "notes/clean.md");
  assert.equal(cites[0].line, 21);
  assert.equal(cites[0].heading, "Section B");
});

test("a cited source keeps its chip", () => {
  const cites = citationsFromAskAgent({
    answer: "Nothing in the prose overlaps the snippet. See [notes/cited.md:4].",
    sources: [
      {
        file: "notes/cited.md",
        line: 4,
        heading: "Elsewhere",
        score: 1,
        cosine: NaN,
        snippet: "unrelated bananas",
        text: "unrelated bananas",
        arms: "find",
      },
      {
        file: "notes/other.md",
        line: 2,
        heading: "Nope",
        score: 1,
        cosine: NaN,
        snippet: "search hit the answer never used",
        text: "search hit the answer never used",
        arms: "find",
      },
    ],
    opened: [],
    ...agentShell,
  });
  assert.equal(cites.length, 1);
  assert.equal(cites[0].file, "notes/cited.md");
  assert.equal(cites[0].line, 4);
  assert.equal(cites[0].heading, "Elsewhere");
});

test("a grep hit the answer did not use gets no chip beside a matched note", () => {
  const cites = citationsFromAskAgent({
    answer: CLEAN_FACT,
    sources: [
      readHit("notes/clean.md", cleanNote),
      {
        file: "notes/recipes.md",
        line: 12,
        heading: "Soup",
        score: NaN,
        cosine: NaN,
        snippet: "Simmer the stock",
        text: "Simmer the stock until it reduces.",
        arms: "grep",
      },
    ],
    opened: [],
    ...agentShell,
  });
  assert.equal(cites.some((c) => c.file === "notes/recipes.md"), false);
  assert.equal(cites.length, 1);
  assert.equal(cites[0].file, "notes/clean.md");
  assert.equal(cites[0].line, 21);
});

const PDF_FACT = "The field code is COPPER FINCH, 312 under Section B.";
const NOTE_FACT = "The notebook codename is COPPER FINCH and the badge is 999.";
const PDF_PAGE = `Section B\n${PDF_FACT}`;
const NOTE = `# Project Heron\n\n${NOTE_FACT}\n`;

function pdfGrep(page, heading, text) {
  return {
    file: "section-b.pdf",
    line: 2,
    heading,
    page,
    score: NaN,
    cosine: NaN,
    snippet: text.split("\n").pop(),
    text,
    arms: "grep",
  };
}

test("(c) the PDF sentence chips only section-b.pdf p.3", () => {
  const cites = citationsFromAskAgent({
    answer: PDF_FACT,
    sources: [
      pdfGrep(3, "Section B", PDF_PAGE),
      pdfGrep(2, "Section A", "Section A\nDecoy sentence about sparrows."),
      {
        file: "project-heron.md",
        line: 3,
        heading: "Project Heron",
        score: NaN,
        cosine: NaN,
        snippet: NOTE_FACT,
        text: NOTE,
        arms: "grep",
      },
    ],
    opened: [],
    ...agentShell,
  });
  assert.equal(cites.length, 1);
  assert.equal(cites[0].file, "section-b.pdf");
  assert.equal(cites[0].page, 3);
  assert.equal(pdfChipLabel(cites[0].file, cites[0].page), "section-b.pdf p.3");
  assert.equal(cites.some((cite) => cite.file === "project-heron.md"), false);
  assert.equal(cites.some((cite) => cite.page === 2), false);
  const title = pdfOpenTitle(cites[0].file, cites[0].page);
  if (PDF_OPEN_LANDS_ON_PAGE) assert.equal(title, "Open section-b.pdf at page 3");
  else assert.equal(title, "Open section-b.pdf");
});

test("(c) the note sentence chips only the note at its heading line", () => {
  const cites = citationsFromAskAgent({
    answer: NOTE_FACT,
    sources: [
      pdfGrep(3, "Section B", PDF_PAGE),
      {
        file: "project-heron.md",
        line: 3,
        heading: "Project Heron",
        score: NaN,
        cosine: NaN,
        snippet: NOTE_FACT,
        text: NOTE,
        arms: "grep",
      },
    ],
    opened: [],
    ...agentShell,
  });
  assert.equal(cites.length, 1);
  assert.equal(cites[0].file, "project-heron.md");
  assert.equal(cites[0].heading, "Project Heron");
  assert.equal(citationLandingLine(cites[0]), 1);
  assert.equal(citationTitle(cites[0].file, citationLandingLine(cites[0]), cites[0].heading), "Open project-heron.md at line 1 › Project Heron");
  assert.equal(cites.some((cite) => cite.file.endsWith(".pdf")), false);
});

test("(b) an empty PDF open does not become a chip", () => {
  const cites = citationsFromAskAgent({
    answer: `Invented: ${PDF_FACT}`,
    sources: [
      {
        file: "scan.pdf",
        line: 1,
        heading: "",
        score: NaN,
        cosine: NaN,
        snippet: "",
        text: "",
        arms: "open",
      },
    ],
    opened: [{ path: "scan.pdf" }],
    ...agentShell,
  });
  assert.deepEqual(cites, []);
});
