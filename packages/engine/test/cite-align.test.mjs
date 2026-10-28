import assert from "node:assert/strict";
import { after, test } from "node:test";

const { alignClockCitations, clockTimes } = await import("../dist/cite-align.js");
const { ask, ChatThread, setModelProvider, resetModelProvider } = await import("../dist/index.js");
const { FakeModelProvider, InMemoryIndex } = await import("../dist/testing.js");

const GOLD = "trips/lisbon-trip-plan.md";
const DISTRACTOR = "meetings/2026-10-05-weekly-sync.md";
const GOLD_TEXT =
  "Day trip to Sintra. Train to Sintra leaves Rossio station at 9:40, so we need to leave the guesthouse by 9:00 at the latest.";
const DISTRACTOR_TEXT = "Weekly sync. The clinic pilot train of thought is still open. No departure is listed.";

after(() => {
  resetModelProvider();
});

test("clockTimes keeps 9:40 distinct from 19:40 and 09:40", () => {
  assert.deepEqual(clockTimes("leaves at 9:40, not 19:40"), ["9:40", "19:40"]);
  assert.deepEqual(clockTimes("pad 09:40"), ["9:40"]);
  assert.deepEqual(clockTimes("Hollis Hall 214"), []);
});

test("F04 shape: gold is [1] and the cited [2] does not contain 9:40", () => {
  const sources = [
    { file: GOLD, heading: "Lisbon trip — winter break", text: GOLD_TEXT },
    { file: DISTRACTOR, heading: "Weekly sync — 2026-10-05", text: DISTRACTOR_TEXT },
  ];
  const raw = "The train to Sintra leaves Rossio station at 9:40 [2].";
  assert.equal(
    alignClockCitations(raw, sources),
    "The train to Sintra leaves Rossio station at 9:40 [1].",
  );
  const both = "The train to Sintra leaves Rossio station at 9:40, so you need to leave the guesthouse by 9:00 at the latest [2].";
  assert.equal(
    alignClockCitations(both, sources),
    "The train to Sintra leaves Rossio station at 9:40, so you need to leave the guesthouse by 9:00 at the latest [1].",
  );
});

test("a cited passage that already contains the time is left alone", () => {
  const sources = [
    { file: "other.md", text: "Standup at 9:40 in the lobby." },
    { file: GOLD, text: GOLD_TEXT },
  ];
  const raw = "The train to Sintra leaves Rossio station at 9:40 [2].";
  assert.equal(alignClockCitations(raw, sources), raw);
});

test("answers with no clock time keep the model's marker", () => {
  const sources = [
    { file: "advisor.md", text: "Your capstone demo is in Hollis Hall 214." },
    { file: "other.md", text: "Inbox capture." },
  ];
  const raw = "Hollis Hall 214 [2].";
  assert.equal(alignClockCitations(raw, sources), raw);
  assert.equal(alignClockCitations("Your notes don't cover this.", sources), "Your notes don't cover this.");
});

test("19:40 in an earlier passage does not steal a 9:40 cite", () => {
  const sources = [
    { file: "late.md", text: "The return is around 19:40." },
    { file: GOLD, text: GOLD_TEXT },
  ];
  const raw = "The train leaves at 9:40 [2].";
  assert.equal(alignClockCitations(raw, sources), raw);
});

test("09:40 in the passage satisfies an answer that says 9:40", () => {
  const sources = [
    { file: GOLD, text: "Train to Sintra leaves Rossio station at 09:40." },
    { file: DISTRACTOR, text: DISTRACTOR_TEXT },
  ];
  assert.equal(
    alignClockCitations("The train leaves at 9:40 [2].", sources),
    "The train leaves at 9:40 [1].",
  );
});

test("same file wins over an earlier passage from a different file", () => {
  const sources = [
    { file: "other.md", text: "Someone else leaves at 9:40." },
    { file: GOLD, heading: "Day 4 — slow day", text: "A slow day in Lisbon. No train time here." },
    { file: GOLD, heading: "Lisbon trip — winter break", text: GOLD_TEXT },
  ];
  assert.equal(
    alignClockCitations("The train leaves at 9:40 [2].", sources),
    "The train leaves at 9:40 [3].",
  );
});

test("each sentence keeps its own clock time", () => {
  const sources = [
    { file: GOLD, text: "Depart at 9:40." },
    { file: "sync.md", text: "The sync is at 10:15." },
  ];
  const raw = "Leave at 9:40 [2]. The sync is at 10:15 [2].";
  assert.equal(alignClockCitations(raw, sources), "Leave at 9:40 [1]. The sync is at 10:15 [2].");
});

function lisbonIndex() {
  const index = new InMemoryIndex();
  index.rebuildIndex({
    mode: "lexical",
    files: 2,
    chunks: [
      {
        id: 31,
        file: GOLD,
        ordinal: 0,
        line: 1,
        heading: "Lisbon trip — winter break",
        text: GOLD_TEXT,
        hash: "h31",
      },
      {
        id: 15,
        file: DISTRACTOR,
        ordinal: 0,
        line: 1,
        heading: "Weekly sync — 2026-10-05",
        text: DISTRACTOR_TEXT,
        hash: "h15",
      },
    ],
  });
  return index;
}

test("ask() and ChatThread renumber a Lisbon [2] and leave a non-time cite", async () => {
  const index = lisbonIndex();
  try {
    setModelProvider(
      new FakeModelProvider({
        models: ["qwen3:4b"],
        chat: () => Promise.resolve("The train to Sintra leaves Rossio station at 9:40 [2]."),
      }),
    );
    const result = await ask(index, "Sintra train", { mode: "lexical" });
    assert.equal(result.sources[0]?.file, GOLD);
    assert.equal(result.sources[1]?.file, DISTRACTOR);
    assert.equal(result.answer, "The train to Sintra leaves Rossio station at 9:40 [1].");
    assert.equal(result.covered, true);

    const thread = new ChatThread(index, { mode: "lexical" });
    const sent = await thread.send("Sintra train");
    assert.equal(sent.sources[0]?.file, GOLD);
    assert.equal(sent.answer, "The train to Sintra leaves Rossio station at 9:40 [1].");
    assert.equal(thread.messages[1]?.content, sent.answer);

    const tokens = [];
    const streamed = await thread.send("Sintra train", { onToken: (token) => tokens.push(token) });
    assert.equal(tokens.join(""), "The train to Sintra leaves Rossio station at 9:40 [2].");
    assert.equal(streamed.answer, "The train to Sintra leaves Rossio station at 9:40 [1].");
    assert.equal(thread.messages.at(-1)?.content, streamed.answer);

    setModelProvider(
      new FakeModelProvider({
        models: ["qwen3:4b"],
        chat: () => Promise.resolve("Hollis Hall 214 [2]."),
      }),
    );
    const rooms = new InMemoryIndex();
    try {
      rooms.rebuildIndex({
        mode: "lexical",
        files: 2,
        chunks: [
          {
            id: 1,
            file: "meetings/advisor-1on1-2026-10-02.md",
            ordinal: 0,
            line: 1,
            heading: "1:1",
            text: "Your capstone demo is in Hollis Hall 214.",
            hash: "a",
          },
          {
            id: 2,
            file: "inbox.md",
            ordinal: 0,
            line: 1,
            heading: "Inbox",
            text: "Hollis left a demo reminder in the inbox.",
            hash: "b",
          },
        ],
      });
      const room = await ask(rooms, "Where is the capstone demo?", { mode: "lexical" });
      assert.equal(room.sources[1]?.file, "inbox.md");
      assert.equal(room.answer, "Hollis Hall 214 [2].");
    } finally {
      rooms.close();
    }
  } finally {
    index.close();
  }
});
