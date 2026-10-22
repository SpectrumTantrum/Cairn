import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

let ask;
let openIndex;
let setModelProvider;
let resetModelProvider;
let FakeModelProvider;
let InMemoryIndex;
let coverageBand;
let UNCOVERED_ANSWER;
let WEAK_MATCH_NOTE;

function vecBuf(values) {
  return Buffer.from(Float32Array.from(values).buffer);
}

function makeVault(markdown) {
  const dir = mkdtempSync(join(tmpdir(), "cairn-ask-hybrid-"));
  writeFileSync(join(dir, "note.md"), markdown);
  return dir;
}

before(async () => {
  const engine = await import("../dist/index.js");
  const testing = await import("../dist/testing.js");
  ask = engine.ask;
  openIndex = engine.openIndex;
  setModelProvider = engine.setModelProvider;
  resetModelProvider = engine.resetModelProvider;
  coverageBand = engine.coverageBand;
  UNCOVERED_ANSWER = engine.UNCOVERED_ANSWER;
  WEAK_MATCH_NOTE = engine.WEAK_MATCH_NOTE;
  FakeModelProvider = testing.FakeModelProvider;
  InMemoryIndex = testing.InMemoryIndex;

  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b", "test-embedder"],
      embed: (_model, input) => Promise.resolve(input.map(() => [1, 0, 0, 0])),
      chat: () => Promise.resolve("Local vaults stay on disk with citations [1]."),
    }),
  );
});

after(() => {
  resetModelProvider();
});

test("ask refuses hybrid ask when coverage threshold is not met", async () => {
  const index = new InMemoryIndex();
  try {
    index.rebuildIndex({
      mode: "hybrid",
      embedder: "test-embedder",
      dim: 4,
      files: 1,
      chunks: [
        {
          id: 1,
          file: "note.md",
          ordinal: 0,
          line: 1,
          heading: "",
          text: "Unrelated botany notes about chloroplast membranes.",
          hash: "h1",
          vector: vecBuf([0, 1, 0, 0]),
        },
      ],
    });

    const result = await ask(index, "cache invalidation", { mode: "hybrid", coverageThreshold: 0.9 });
    assert.equal(result.covered, false);
    assert.equal(result.grounded, false);
    assert.match(result.answer, /don't cover/i);
  } finally {
    index.close();
  }
});

test("ask returns grounded hybrid answers when retrieval is covered", async () => {
  const vault = makeVault("# Notes\n\nCache invalidation is naming things.");
  try {
    await import("../dist/index.js").then((engine) => engine.indexVault(vault, { lexical: true }));
    const index = openIndex(vault);
    try {
      const result = await ask(index, "What is cache invalidation?", { mode: "lexical" });
      assert.equal(result.covered, true);
      assert.equal(result.grounded, true);
      assert.ok(result.sources.length > 0);
      assert.match(result.answer, /\[1\]/);
    } finally {
      index.close();
    }
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

function vec(values) {
  return Buffer.from(Float32Array.from(values).buffer);
}

/** Unit vector whose cosine with the fake query embed [1,0,0,0] is `cosine`. */
function cosineVec(cosine) {
  const y = Math.sqrt(Math.max(0, 1 - cosine * cosine));
  return vec([cosine, y, 0, 0]);
}

function hybridIndex(cosine) {
  const index = new InMemoryIndex();
  index.rebuildIndex({
    mode: "hybrid",
    embedder: "test-embedder",
    dim: 4,
    files: 1,
    chunks: [
      {
        id: 1,
        file: "finch.md",
        ordinal: 0,
        line: 1,
        heading: "Copper finch",
        text: "The copper finch lives in the margin of the ledger.",
        hash: "h1",
        vector: cosineVec(cosine),
      },
    ],
  });
  return index;
}

const FINCH_QUESTION = "Where does the copper finch live?";

test("coverageBand splits strong, weak, and refuse, and leaves lexical NaN alone", () => {
  assert.equal(coverageBand({ covered: true, poolMaxCosine: 0.5, threshold: 0.5 }), "strong");
  assert.equal(coverageBand({ covered: false, poolMaxCosine: 0.2, threshold: 0.5 }), "weak");
  assert.equal(coverageBand({ covered: false, poolMaxCosine: 0.199, threshold: 0.5 }), "refuse");
  assert.equal(coverageBand({ covered: true, poolMaxCosine: Number.NaN, threshold: 0.5 }), "strong");
  assert.equal(coverageBand({ covered: false, poolMaxCosine: Number.NaN, threshold: 0.5 }), "refuse");
});

test("ask keeps a strong hybrid answer and does not add the weak-match note", async () => {
  const seen = [];
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b", "test-embedder"],
      chat: (_model, messages) => {
        seen.push(messages);
        return Promise.resolve("It lives in the margin.");
      },
    }),
  );
  const index = hybridIndex(0.9);
  try {
    const result = await ask(index, FINCH_QUESTION, { mode: "hybrid" });
    assert.equal(seen.length, 1);
    const user = seen[0].at(-1).content;
    assert.equal(user.includes(WEAK_MATCH_NOTE), false);
    assert.equal(result.answer, "It lives in the margin.");
    assert.equal(result.covered, true);
    assert.ok(result.poolMaxCosine >= 0.5);
  } finally {
    index.close();
  }
});

test("ask calls the model in the weak band and keeps an answer that cites [n]", async () => {
  const seen = [];
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b", "test-embedder"],
      chat: (_model, messages) => {
        seen.push(messages);
        return Promise.resolve("It lives in the margin of the ledger [1].");
      },
    }),
  );
  const index = hybridIndex(0.35);
  try {
    const result = await ask(index, FINCH_QUESTION, { mode: "hybrid" });
    assert.equal(seen.length, 1);
    const user = seen[0].at(-1).content;
    assert.ok(user.indexOf("QUESTION:") < user.indexOf(WEAK_MATCH_NOTE));
    assert.equal(result.answer, "It lives in the margin of the ledger [1].");
    assert.equal(result.covered, true);
    assert.equal(result.grounded, true);
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].file, "finch.md");
    assert.ok(result.poolMaxCosine >= 0.2 && result.poolMaxCosine < 0.5);
  } finally {
    index.close();
  }
});

test("the weak-band note adds the paraphrase line and keeps the decline sentence", () => {
  assert.equal(
    WEAK_MATCH_NOTE,
    [
      "These notes may only partly cover the question.",
      "The question may use different words than the notes (for example \u2018throttle\u2019 or \u2018cap\u2019 for a rate limit); the answer may sit in a table or list.",
      'The answer may sit in a table, a list, or wording that differs from the question. Answer only from them, and cite each claim with [n]. If they do not contain the answer, reply exactly: "Your notes don\'t cover this."',
    ].join("\n"),
  );
});

test("ask collapses a strong-band preamble plus the refusal sentence when it has no [n]", async () => {
  const preamble = `The sources do not mention an enterprise plan; they only describe the Free and Pro plans. ${UNCOVERED_ANSWER}`;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b", "test-embedder"],
      chat: () => Promise.resolve(preamble),
    }),
  );
  const index = hybridIndex(0.9);
  try {
    const result = await ask(index, FINCH_QUESTION, { mode: "hybrid" });
    assert.equal(result.answer, UNCOVERED_ANSWER);
    assert.equal(result.covered, false);
    assert.equal(result.grounded, false);
    assert.deepEqual(result.sources, []);
    assert.equal(result.model, "qwen3:4b");
    assert.equal(result.reason, undefined);
    assert.ok(result.poolMaxCosine >= 0.5);
  } finally {
    index.close();
  }
});

test("ask leaves a strong answer that quotes the refusal sentence and cites [n]", async () => {
  const quoted = `The notes record the limit, then say "${UNCOVERED_ANSWER}" [1]`;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b", "test-embedder"],
      chat: () => Promise.resolve(quoted),
    }),
  );
  const index = hybridIndex(0.9);
  try {
    const result = await ask(index, FINCH_QUESTION, { mode: "hybrid" });
    assert.equal(result.answer, quoted);
    assert.equal(result.covered, true);
    assert.equal(result.grounded, true);
    assert.equal(result.sources[0].file, "finch.md");
  } finally {
    index.close();
  }
});

test("ask suppresses a weak-band answer that has no [n] citation", async () => {
  let calls = 0;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b", "test-embedder"],
      chat: () => {
        calls += 1;
        return Promise.resolve("It lives in the margin of the ledger.");
      },
    }),
  );
  const index = hybridIndex(0.35);
  try {
    const result = await ask(index, FINCH_QUESTION, { mode: "hybrid" });
    assert.equal(calls, 1);
    assert.equal(result.answer, UNCOVERED_ANSWER);
    assert.equal(result.covered, false);
    assert.equal(result.grounded, false);
    assert.deepEqual(result.sources, []);
    assert.equal(result.model, "qwen3:4b");
  } finally {
    index.close();
  }
});

test("ask legacy gate refuses a 0.35 cosine without calling the model", async () => {
  let calls = 0;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b", "test-embedder"],
      chat: () => {
        calls += 1;
        return Promise.resolve("It lives in the margin of the ledger [1].");
      },
    }),
  );
  const index = hybridIndex(0.35);
  try {
    const result = await ask(index, FINCH_QUESTION, { mode: "hybrid", gate: "legacy" });
    assert.equal(calls, 0);
    assert.equal(result.answer, UNCOVERED_ANSWER);
    assert.equal(result.model, undefined);
    assert.equal(result.covered, false);
    assert.match(result.reason, /coverage threshold/i);
    assert.ok(result.poolMaxCosine >= 0.2 && result.poolMaxCosine < 0.5);
    assert.equal(result.topChunks.length, 1);
    assert.equal(result.topChunks[0].file, "finch.md");
    assert.equal(result.topChunks[0].id, 1);
    assert.equal(result.topChunks[0].heading, "Copper finch");
    assert.equal(result.topChunks[0].cosine, result.poolMaxCosine);
  } finally {
    index.close();
  }
});

test("ask legacy gate still collapses an uncited strong answer that contains the refusal sentence", async () => {
  const preamble = `The sources do not mention an enterprise plan. ${UNCOVERED_ANSWER}`;
  const seen = [];
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b", "test-embedder"],
      chat: (_model, messages) => {
        seen.push(messages);
        return Promise.resolve(preamble);
      },
    }),
  );
  const index = hybridIndex(0.9);
  try {
    const result = await ask(index, FINCH_QUESTION, { mode: "hybrid", gate: "legacy" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].at(-1).content.includes(WEAK_MATCH_NOTE), false);
    assert.equal(result.answer, UNCOVERED_ANSWER);
    assert.equal(result.model, "qwen3:4b");
    assert.deepEqual(result.sources, []);
  } finally {
    index.close();
  }
});

test("ask forwards temperature and seed only when the caller sets them", async () => {
  const seen = [];
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b", "test-embedder"],
      chat: (_model, _messages, _think, sampling) => {
        seen.push(sampling);
        return Promise.resolve("It lives in the margin of the ledger [1].");
      },
    }),
  );
  const sampled = hybridIndex(0.9);
  try {
    const result = await ask(sampled, FINCH_QUESTION, { mode: "hybrid", temperature: 0, seed: 42 });
    assert.deepEqual(seen, [{ temperature: 0, seed: 42 }]);
    assert.equal(result.topChunks[0].file, "finch.md");
    assert.equal(result.topChunks[0].id, 1);
  } finally {
    sampled.close();
  }
  seen.length = 0;
  const plain = hybridIndex(0.9);
  try {
    await ask(plain, FINCH_QUESTION, { mode: "hybrid" });
    assert.deepEqual(seen, [undefined]);
  } finally {
    plain.close();
  }
});

test("ask refuses below the coverage floor without calling the model", async () => {
  let calls = 0;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b", "test-embedder"],
      chat: () => {
        calls += 1;
        return Promise.resolve("should not be called [1]");
      },
    }),
  );
  const index = hybridIndex(0.1);
  try {
    const result = await ask(index, FINCH_QUESTION, { mode: "hybrid" });
    assert.equal(calls, 0);
    assert.equal(result.answer, UNCOVERED_ANSWER);
    assert.equal(result.covered, false);
    assert.equal(result.grounded, false);
    assert.deepEqual(result.sources, []);
    assert.match(result.reason, /coverage threshold/i);
    assert.ok(result.poolMaxCosine < 0.2);
  } finally {
    index.close();
  }
});

test("ask leaves lexical mode unchanged, including an answer with no [n]", async () => {
  const seen = [];
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b", "test-embedder"],
      chat: (_model, messages) => {
        seen.push(messages);
        return Promise.resolve("A vault is a folder of notes.");
      },
    }),
  );
  const index = new InMemoryIndex();
  try {
    index.rebuildIndex({
      mode: "lexical",
      files: 1,
      chunks: [
        {
          id: 1,
          file: "vault.md",
          ordinal: 0,
          line: 1,
          heading: "Vaults",
          text: "A vault is a folder of Markdown notes.",
          hash: "h1",
        },
      ],
    });
    const result = await ask(index, "What is a vault?", { mode: "lexical" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].at(-1).content.includes(WEAK_MATCH_NOTE), false);
    assert.equal(result.answer, "A vault is a folder of notes.");
    assert.equal(result.covered, true);
    assert.equal(result.mode, "lexical");
    assert.equal(Number.isNaN(result.poolMaxCosine), true);
  } finally {
    index.close();
  }
});
