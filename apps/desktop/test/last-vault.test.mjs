// Last-vault gate. No Electron: the store lives in a tmp dir. Proves:
//   * a directory that still exists is reopened, including across a new store;
//   * a missing, chmod 000, or non-directory path uses the Couldn't find sentence;
//   * a corrupt settings file shows the picker and does not throw;
//   * a dev remount (two restores) logs once and opens index.db once.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const { LastVaultStore, runLastVaultRestore } = await import("../out-test/last-vault.js");
const { couldntFindVaultMessage, createVaultOpenGate } = await import("../out-test/vault-open.js");
const { createVaultSession } = await import("../out-test/vault-session.js");
const { InMemoryIndex } = await import("@cairn/engine/testing");

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "cairn-last-vault-"));
  const filePath = join(dir, "last-vault.json");
  return { store: new LastVaultStore(filePath), filePath, dir };
}

/** macOS realpath maps `/var` to `/private/var`. Compare the canonical directory. */
function realDir(path) {
  return realpathSync.native(path);
}

function indexWithChunk(vault) {
  const index = new InMemoryIndex(vault);
  index.rebuildIndex({
    mode: "lexical",
    files: 1,
    chunks: [
      {
        id: 1,
        file: "note.md",
        ordinal: 0,
        line: 1,
        heading: "",
        text: "alpha finch",
        hash: "h1",
      },
    ],
  });
  return index;
}

test("an existing vault is reopened, including after a restart", () => {
  const { store, filePath, dir } = makeStore();
  const vault = join(dir, "notes");
  mkdirSync(vault);
  try {
    store.remember(vault);
    const saved = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(saved.version, 1);
    assert.equal(saved.path, realDir(vault));

    const restored = store.restore();
    assert.equal(restored.path, realDir(vault));
    assert.equal(restored.cleared, null);
    assert.equal(restored.message, null);

    const again = new LastVaultStore(filePath).restore();
    assert.equal(again.path, realDir(vault));
    assert.equal(again.cleared, null);
    assert.equal(again.message, null);
    assert.equal(existsSync(filePath), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing vault shows the picker and clears the stale entry", () => {
  const { store, filePath, dir } = makeStore();
  const vault = join(dir, "gone");
  mkdirSync(vault);
  try {
    store.remember(vault);
    const savedPath = realDir(vault);
    rmSync(vault, { recursive: true, force: true });

    const restored = store.restore();
    assert.equal(restored.path, null);
    assert.equal(restored.cleared, "unavailable");
    assert.equal(restored.message, couldntFindVaultMessage(savedPath));
    assert.equal(existsSync(filePath), false);

    const second = store.restore();
    assert.equal(second.path, null);
    assert.equal(second.message, couldntFindVaultMessage(savedPath));

    const again = new LastVaultStore(filePath).restore();
    assert.equal(again.path, null);
    assert.equal(again.cleared, null);
    assert.equal(again.message, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable vault shows the picker and clears the stale entry", { skip: process.getuid?.() === 0 }, () => {
  const { store, filePath, dir } = makeStore();
  const vault = join(dir, "locked");
  mkdirSync(vault);
  writeFileSync(join(vault, "secret.md"), "hidden\n", "utf8");
  try {
    store.remember(vault);
    const savedPath = realDir(vault);
    chmodSync(vault, 0o000);

    const restored = store.restore();
    assert.equal(restored.path, null);
    assert.equal(restored.cleared, "unavailable");
    assert.equal(restored.message, couldntFindVaultMessage(savedPath));
    assert.equal(existsSync(filePath), false);
  } finally {
    chmodSync(vault, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remembering a missing folder uses the Couldn't find sentence", () => {
  const { store, dir } = makeStore();
  const missing = join(dir, "gone");
  try {
    assert.throws(
      () => store.remember(missing),
      (err) => err instanceof Error && err.message === couldntFindVaultMessage(missing),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt settings file shows the picker and does not throw", () => {
  const { store, filePath, dir } = makeStore();
  try {
    writeFileSync(filePath, "{not json", "utf8");
    const restored = store.restore();
    assert.equal(restored.path, null);
    assert.equal(restored.cleared, "corrupt");
    assert.equal(restored.message, null);
    assert.equal(existsSync(filePath), false);

    writeFileSync(filePath, JSON.stringify({ version: 1, path: 12 }), "utf8");
    const shaped = new LastVaultStore(filePath).restore();
    assert.equal(shaped.path, null);
    assert.equal(shaped.cleared, "corrupt");
    assert.equal(shaped.message, null);
    assert.equal(existsSync(filePath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opening a different vault replaces the saved path", () => {
  const { store, filePath, dir } = makeStore();
  const first = join(dir, "first");
  const second = join(dir, "second");
  mkdirSync(first);
  mkdirSync(second);
  try {
    store.remember(first);
    store.remember(second);
    const restored = store.restore();
    assert.equal(restored.path, realDir(second));
    assert.equal(restored.cleared, null);
    assert.equal(JSON.parse(readFileSync(filePath, "utf8")).path, realDir(second));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a non-directory and a broken symlink show the picker and are cleared", () => {
  const { store, filePath, dir } = makeStore();
  const file = join(dir, "notes.md");
  const link = join(dir, "broken");
  writeFileSync(file, "hello\n", "utf8");
  symlinkSync(join(dir, "missing-target"), link);
  try {
    writeFileSync(filePath, JSON.stringify({ version: 1, path: file }), "utf8");
    const notDir = store.restore();
    assert.equal(notDir.path, null);
    assert.equal(notDir.cleared, "unavailable");
    assert.equal(notDir.message, couldntFindVaultMessage(file));
    assert.equal(existsSync(filePath), false);

    writeFileSync(filePath, JSON.stringify({ version: 1, path: link }), "utf8");
    const broken = new LastVaultStore(filePath).restore();
    assert.equal(broken.path, null);
    assert.equal(broken.cleared, "unavailable");
    assert.equal(broken.message, couldntFindVaultMessage(link));
    assert.equal(existsSync(filePath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no saved file stays absent and shows the picker", () => {
  const { store, filePath, dir } = makeStore();
  try {
    const restored = store.restore();
    assert.equal(restored.path, null);
    assert.equal(restored.cleared, null);
    assert.equal(existsSync(filePath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a relaunch logs once and reads index.db once, including a second call", async () => {
  const { store, dir } = makeStore();
  const vault = join(dir, "notes");
  mkdirSync(join(vault, ".cairn"), { recursive: true });
  writeFileSync(join(vault, ".cairn", "index.db"), "");
  let reads = 0;
  const session = createVaultSession({
    openIndex: () => {
      reads += 1;
      return indexWithChunk(vault);
    },
  });
  try {
    store.remember(vault);
    const gate = createVaultOpenGate();
    const logs = [];
    const work = () =>
      runLastVaultRestore({
        store,
        openVault: (path) => session.openVault(path),
        log: (line) => logs.push(line),
      });
    const first = gate.run("launch", work);
    const second = gate.run("launch", work);
    const [a, b] = await Promise.all([first, second]);
    const again = await gate.run("launch", work);
    assert.equal(reads, 1);
    assert.deepEqual(logs, [`[cairn] reopened vault ${realDir(vault)}`]);
    assert.equal(a.path, realDir(vault));
    assert.equal(a.message, null);
    assert.equal(a.index?.chunks, 1);
    assert.equal(b.index?.files, 1);
    assert.deepEqual(again, a);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearing a missing vault logs the notice once when restore runs twice", async () => {
  const { store, dir } = makeStore();
  const vault = join(dir, "gone");
  mkdirSync(vault);
  try {
    store.remember(vault);
    const savedPath = realDir(vault);
    rmSync(vault, { recursive: true, force: true });
    const gate = createVaultOpenGate();
    const logs = [];
    let opens = 0;
    const work = () =>
      runLastVaultRestore({
        store,
        openVault: async () => {
          opens += 1;
          throw new Error("should not open");
        },
        log: (line) => logs.push(line),
      });
    const first = gate.run("launch", work);
    const second = gate.run("launch", work);
    const [a, b] = await Promise.all([first, second]);
    await gate.run("launch", work);
    assert.equal(opens, 0);
    assert.deepEqual(logs, [
      "[cairn] cleared last vault (unavailable); vault picker",
      `[cairn] ${couldntFindVaultMessage(savedPath)}`,
    ]);
    assert.equal(a.message, couldntFindVaultMessage(savedPath));
    assert.equal(b.path, null);
    assert.equal(a.index, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("choose and reopen apply the index stats from that single read", () => {
  const app = readFileSync(new URL("../src/renderer/App.tsx", import.meta.url), "utf8");
  const adoptStart = app.indexOf("async function adoptVault");
  const adoptEnd = app.indexOf("async function chooseVault", adoptStart);
  assert.ok(adoptStart !== -1 && adoptEnd !== -1);
  const adopt = app.slice(adoptStart, adoptEnd);
  assert.match(adopt, /existingIndex: IndexStats \| null = null/);
  assert.match(adopt, /setIndexStats\(existingIndex\)/);
  assert.match(adopt, /setIndexState\(existingIndex \? "indexed" : "none"\)/);

  const chooseStart = app.indexOf("async function chooseVault");
  const chooseEnd = app.indexOf("useEffect", chooseStart);
  const choose = app.slice(chooseStart, chooseEnd);
  assert.match(choose, /adoptVault\(selected\.path, selected\.index\)/);

  const restoreStart = app.indexOf("restored = await window.cairn.restoreLastVault()");
  const restoreEnd = app.indexOf("const toggleFolder", restoreStart);
  assert.ok(restoreStart !== -1 && restoreEnd !== -1);
  const restore = app.slice(restoreStart, restoreEnd);
  assert.match(restore, /adoptVault\(restored\.path, restored\.index \?\? null\)/);
  assert.match(restore, /setVaultNotice\(restored\.message\)/);

  const ipc = readFileSync(new URL("../src/main/ipc.ts", import.meta.url), "utf8");
  assert.match(ipc, /openGate\.run\(\s*"launch"/);
  assert.match(ipc, /openVault: \(path\) => session\.openVault\(path\)/);
  assert.equal(ipc.includes("reopened vault"), false);

  const launch = readFileSync(new URL("../src/main/last-vault.ts", import.meta.url), "utf8");
  assert.equal(launch.split("reopened vault").length - 1, 1);
  assert.equal(launch.split("cleared last vault").length - 1, 3);
});
