import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const { createVaultSession } = await import("../out-test/vault-session.js");
const { commitCheckpoint, revertRun } = await import("../out-test/agent-checkpoint.js");
const { InMemoryIndex, FakeModelProvider } = await import("@cairn/engine/testing");
const { setModelProvider, resetModelProvider } = await import("@cairn/engine");

/** A vault dir with a seeded note on disk and an index.db marker so assertIndexed passes. */
function makeVault(files = {}) {
  const vault = mkdtempSync(join(tmpdir(), "cairn-agent-"));
  mkdirSync(join(vault, ".cairn"), { recursive: true });
  writeFileSync(join(vault, ".cairn", "index.db"), "");
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(vault, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return vault;
}

/** A lexical InMemoryIndex covering the seeded notes so runAgent's grounding retrieves them. */
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

function hasCheckpointRepo(vault) {
  try {
    return statSync(join(vault, ".cairn", "checkpoints.git")).isDirectory();
  } catch {
    return false;
  }
}

/** Scripts the tool-loop: each entry is one model turn's tool calls; [] ends the run. */
function scriptedProvider(script) {
  return new FakeModelProvider({
    models: ["qwen3:4b"],
    chatWithTools: async (_model, _messages, _tools, turn) => {
      const calls = script[turn - 1] ?? [];
      return { content: calls.length ? "" : "Done.", toolCalls: calls };
    },
  });
}

test("rejecting every proposal leaves the vault byte-identical and takes no checkpoint", async () => {
  const vault = makeVault({ "note.md": "# Note\n\nOriginal.\n" });
  setModelProvider(
    scriptedProvider([
      [{ name: "propose_edit", arguments: { path: "note.md", newContent: "# Note\n\nRewritten [1].\n" } }],
      [],
    ]),
  );
  try {
    const before = snapshot(vault);
    const session = createVaultSession({ openIndex: () => indexFor(vault, [{ file: "note.md", text: "note original" }]) });
    session.setVault(vault);

    const run = await session.agentStart("rewrite the note original");
    assert.equal(run.proposals.length, 1);

    const res = session.agentRejectHunk(run.runId, run.proposals[0].id);
    assert.equal(res.status, "rejected");
    assert.equal(res.appliedCount, 0);

    // The load-bearing invariant: a rejected diff leaves the vault byte-identical.
    assert.deepEqual(snapshot(vault), before);
    // And no git checkpoint was ever taken — the gate is reached only on apply.
    assert.equal(hasCheckpointRepo(vault), false);
  } finally {
    resetModelProvider();
    rmSync(vault, { recursive: true, force: true });
  }
});

test("approving a hunk snapshots, then writes the file and commits it", async () => {
  const vault = makeVault({ "note.md": "# Note\n\nOriginal.\n" });
  setModelProvider(
    scriptedProvider([
      [{ name: "propose_edit", arguments: { path: "note.md", newContent: "# Note\n\nRewritten [1].\n" } }],
      [],
    ]),
  );
  try {
    const session = createVaultSession({ openIndex: () => indexFor(vault, [{ file: "note.md", text: "note original" }]) });
    session.setVault(vault);
    const run = await session.agentStart("rewrite the note original");

    const res = await session.agentApplyHunk(run.runId, run.proposals[0].id);
    assert.equal(res.status, "applied");
    assert.equal(res.appliedCount, 1);
    assert.equal(res.content, "# Note\n\nRewritten [1].\n");

    // The write reached disk only through the gate...
    assert.equal(readFileSync(join(vault, "note.md"), "utf8"), "# Note\n\nRewritten [1].\n");
    // ...and a checkpoint was taken before it.
    assert.equal(hasCheckpointRepo(vault), true);
  } finally {
    resetModelProvider();
    rmSync(vault, { recursive: true, force: true });
  }
});

test("reverting a run (add + modify) restores the vault byte-identical", async () => {
  const vault = makeVault({ "note.md": "# Note\n\nOriginal body.\n" });
  setModelProvider(
    scriptedProvider([
      [{ name: "propose_edit", arguments: { path: "note.md", newContent: "# Note\n\nChanged [1].\n" } }],
      [{ name: "propose_edit", arguments: { path: "sub/new.md", newContent: "# New\n\nFrom [1].\n" } }],
      [],
    ]),
  );
  try {
    const before = snapshot(vault);
    const session = createVaultSession({ openIndex: () => indexFor(vault, [{ file: "note.md", text: "note original body" }]) });
    session.setVault(vault);
    const run = await session.agentStart("rewrite the note original body and add a new one");
    assert.equal(run.proposals.length, 2);

    for (const p of run.proposals) {
      const res = await session.agentApplyHunk(run.runId, p.id);
      assert.equal(res.status, "applied");
    }
    // Both writes landed.
    assert.equal(readFileSync(join(vault, "note.md"), "utf8"), "# Note\n\nChanged [1].\n");
    assert.equal(readFileSync(join(vault, "sub", "new.md"), "utf8"), "# New\n\nFrom [1].\n");

    const { reverted } = await session.agentRevertRun(run.runId);
    assert.equal(reverted, true);
    // Byte-identical: modified note restored, created note gone.
    assert.deepEqual(snapshot(vault), before);
  } finally {
    resetModelProvider();
    rmSync(vault, { recursive: true, force: true });
  }
});

test("applying an edit to a path outside the vault is refused", async () => {
  const vault = makeVault({ "note.md": "# Note\n" });
  setModelProvider(
    scriptedProvider([
      [{ name: "propose_edit", arguments: { path: "../escape.md", newContent: "owned" } }],
      [],
    ]),
  );
  try {
    const session = createVaultSession({ openIndex: () => indexFor(vault, [{ file: "note.md", text: "note" }]) });
    session.setVault(vault);
    const run = await session.agentStart("note");
    assert.equal(run.proposals.length, 1);
    await assert.rejects(
      () => session.agentApplyHunk(run.runId, run.proposals[0].id),
      /Refusing to open a path outside/,
    );
  } finally {
    resetModelProvider();
    rmSync(vault, { recursive: true, force: true });
  }
});

test("an external edit between propose and apply is skipped, never clobbered", async () => {
  const vault = makeVault({ "note.md": "# Note\n\nOriginal.\n" });
  setModelProvider(
    scriptedProvider([
      [{ name: "propose_edit", arguments: { path: "note.md", newContent: "# Note\n\nAgent version.\n" } }],
      [],
    ]),
  );
  try {
    const session = createVaultSession({ openIndex: () => indexFor(vault, [{ file: "note.md", text: "note original" }]) });
    session.setVault(vault);
    const run = await session.agentStart("rewrite note original");

    // Simulate Obsidian editing the file after the agent read it.
    writeFileSync(join(vault, "note.md"), "# Note\n\nHuman edit meanwhile.\n");

    const res = await session.agentApplyHunk(run.runId, run.proposals[0].id);
    assert.equal(res.status, "skipped");
    assert.match(res.reason, /changed on disk/);
    // The human's edit survives — the agent never clobbered it.
    assert.equal(readFileSync(join(vault, "note.md"), "utf8"), "# Note\n\nHuman edit meanwhile.\n");
  } finally {
    resetModelProvider();
    rmSync(vault, { recursive: true, force: true });
  }
});

test("revertRun restores byte-identical across add + modify + delete (ADR-0008 §4)", async () => {
  // Exercises the full revert change-set directly: the two-tool loop cannot delete,
  // so this covers the delete-restore branch the ADR acceptance criterion requires.
  const vault = makeVault({ "mod.md": "original\n", "del.md": "to be deleted\n" });
  try {
    const g = (args) =>
      execFileSync("git", args, {
        cwd: vault,
        env: {
          ...process.env,
          GIT_DIR: join(vault, ".cairn", "checkpoints.git"),
          GIT_WORK_TREE: vault,
        },
      }).toString();

    const before = snapshot(vault);
    const a = await commitCheckpoint(vault, "run-1"); // checkpoint A

    // A run that modifies, deletes, and adds — committed as run-commit B.
    writeFileSync(join(vault, "mod.md"), "changed\n");
    rmSync(join(vault, "del.md"));
    writeFileSync(join(vault, "new.md"), "brand new\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "run B"]);
    const b = g(["rev-parse", "HEAD"]).trim();

    const result = await revertRun(vault, a, b, "run-1");
    assert.equal(result.byteIdentical, true);
    assert.equal(result.treeA, result.treeC);
    assert.deepEqual(snapshot(vault), before);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
