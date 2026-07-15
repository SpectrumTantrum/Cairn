import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const { createVaultSession } = await import("../out-test/vault-session.js");
const { InMemoryIndex, FakeModelProvider } = await import("@cairn/engine/testing");
const { setModelProvider, resetModelProvider } = await import("@cairn/engine");

/** A vault dir with seeded notes on disk and an index.db marker so assertIndexed passes. */
function makeVault(files = {}) {
  const vault = mkdtempSync(join(tmpdir(), "cairn-studio-"));
  mkdirSync(join(vault, ".cairn"), { recursive: true });
  writeFileSync(join(vault, ".cairn", "index.db"), "");
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(vault, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return vault;
}

/** A lexical InMemoryIndex covering the seeded notes so generation's retrieval finds them. */
function indexFor(vault, entries) {
  const index = new InMemoryIndex(vault);
  index.rebuildIndex({
    mode: "lexical",
    files: new Set(entries.map((e) => e.file)).size,
    chunks: entries.map((e, i) => ({
      id: i + 1,
      file: e.file,
      ordinal: 0,
      line: 1,
      heading: "",
      text: e.text,
      hash: `h${i + 1}`,
    })),
  });
  return index;
}

/** Snapshot the whole vault (relative path → content), excluding the .cairn sidecar. */
function snapshot(vault) {
  const out = {};
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".cairn") continue;
      const abs = join(dir, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, r);
      else if (entry.isFile()) out[r] = readFileSync(abs, "utf8");
    }
  };
  walk(vault, "");
  return out;
}

/** A fake model whose chat() returns a fixed study-guide body (no tool-calling needed). */
function studyGuideProvider(body) {
  return new FakeModelProvider({ models: ["qwen3:4b"], chat: async () => body });
}

const BODY = "## Overview\n\nSpaced repetition fights forgetting [1].\n\n## Key concepts\n\n- Spacing effect [1].\n\n## Self-check questions\n\n1. What is it?";

test("studioGenerate proposes a single cited note and never writes until approved", async () => {
  const vault = makeVault({ "spacing.md": "# Spacing\n\nOriginal.\n" });
  setModelProvider(studyGuideProvider(BODY));
  try {
    const before = snapshot(vault);
    const session = createVaultSession({
      openIndex: () => indexFor(vault, [{ file: "spacing.md", text: "spaced repetition reviews at increasing intervals" }]),
    });
    session.setVault(vault);

    const run = await session.studioGenerate("study-guide", { topic: "spaced repetition" });
    assert.equal(run.proposals.length, 1);
    const p = run.proposals[0];
    assert.equal(p.op, "add");
    assert.match(p.path, /^Study Guide - spaced repetition\.md$/);
    // Citation spine: the proposed content links back to the source note.
    assert.match(p.newContent, /## Sources/);
    assert.match(p.newContent, /\[\[spacing\.md\]\]/);
    assert.ok(run.sources.length > 0);

    // The invariant: nothing on disk changed — generation only proposed.
    assert.deepEqual(snapshot(vault), before);
  } finally {
    resetModelProvider();
    rmSync(vault, { recursive: true, force: true });
  }
});

test("approving a Studio note writes it through the ADR-0008 gate, and revert restores byte-identically", async () => {
  const vault = makeVault({ "spacing.md": "# Spacing\n\nOriginal.\n" });
  setModelProvider(studyGuideProvider(BODY));
  try {
    const before = snapshot(vault);
    const session = createVaultSession({
      openIndex: () => indexFor(vault, [{ file: "spacing.md", text: "spaced repetition reviews at increasing intervals" }]),
    });
    session.setVault(vault);

    const run = await session.studioGenerate("study-guide", { topic: "spaced repetition" });
    const proposal = run.proposals[0];

    const res = await session.agentApplyHunk(run.runId, proposal.id);
    assert.equal(res.status, "applied");
    assert.equal(res.appliedCount, 1);
    // The generated note reached disk only through the shared apply gate.
    const written = readFileSync(join(vault, proposal.path), "utf8");
    assert.equal(written, proposal.newContent);
    assert.match(written, /\[\[spacing\.md\]\]/);

    // Revert the run — the created note is removed, the vault is byte-identical again.
    const { reverted } = await session.agentRevertRun(run.runId);
    assert.equal(reverted, true);
    assert.deepEqual(snapshot(vault), before);
  } finally {
    resetModelProvider();
    rmSync(vault, { recursive: true, force: true });
  }
});

test("a filename collision is resolved to a unique path at generation time", async () => {
  // A note already occupies the default Study Guide path.
  const vault = makeVault({
    "spacing.md": "# Spacing\n\nOriginal.\n",
    "Study Guide - spaced repetition.md": "# Pre-existing\n",
  });
  setModelProvider(studyGuideProvider(BODY));
  try {
    const session = createVaultSession({
      openIndex: () => indexFor(vault, [{ file: "spacing.md", text: "spaced repetition reviews at increasing intervals" }]),
    });
    session.setVault(vault);
    const run = await session.studioGenerate("study-guide", { topic: "spaced repetition" });
    assert.equal(run.proposals[0].path, "Study Guide - spaced repetition 2.md");
  } finally {
    resetModelProvider();
    rmSync(vault, { recursive: true, force: true });
  }
});

test("studioGenerate refuses (zero proposals) when retrieval does not cover the topic", async () => {
  const vault = makeVault({ "spacing.md": "# Spacing\n\nOriginal.\n" });
  setModelProvider(studyGuideProvider("should never run"));
  try {
    const session = createVaultSession({
      openIndex: () => indexFor(vault, [{ file: "spacing.md", text: "spaced repetition reviews at increasing intervals" }]),
    });
    session.setVault(vault);
    const run = await session.studioGenerate("study-guide", { topic: "quantum chromodynamics tax law" });
    assert.equal(run.proposals.length, 0);
    assert.equal(run.grounded, false);
    assert.match(run.answer, /don't cover/i);
  } finally {
    resetModelProvider();
    rmSync(vault, { recursive: true, force: true });
  }
});
