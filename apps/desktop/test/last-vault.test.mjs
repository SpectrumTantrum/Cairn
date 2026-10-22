// Last-vault gate. No Electron: the store lives in a tmp dir. Proves:
//   * a directory that still exists is reopened, including across a new store;
//   * a missing directory shows the picker and the stale entry is cleared;
//   * a corrupt settings file shows the picker and does not throw;
//   * remembering a different vault replaces the entry.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const { LastVaultStore, missingLastVaultMessage } = await import("../out-test/last-vault.js");

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "cairn-last-vault-"));
  const filePath = join(dir, "last-vault.json");
  return { store: new LastVaultStore(filePath), filePath, dir };
}

/** macOS realpath maps `/var` to `/private/var`. Compare the canonical directory. */
function realDir(path) {
  return realpathSync.native(path);
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
    assert.equal(restored.message, missingLastVaultMessage(savedPath));
    assert.equal(existsSync(filePath), false);

    // Later reads in the same process still have the sentence (dev mounts twice).
    const second = store.restore();
    assert.equal(second.path, null);
    assert.equal(second.message, missingLastVaultMessage(savedPath));
    const third = store.restore();
    assert.equal(third.message, missingLastVaultMessage(savedPath));

    const again = new LastVaultStore(filePath).restore();
    assert.equal(again.path, null);
    assert.equal(again.cleared, null);
    assert.equal(again.message, null);

    const replacement = join(dir, "replacement");
    mkdirSync(replacement);
    store.remember(replacement);
    const reopened = store.restore();
    assert.equal(reopened.path, realDir(replacement));
    assert.equal(reopened.message, null);
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
    assert.equal(notDir.message, missingLastVaultMessage(file));
    assert.equal(existsSync(filePath), false);

    writeFileSync(filePath, JSON.stringify({ version: 1, path: link }), "utf8");
    const broken = new LastVaultStore(filePath).restore();
    assert.equal(broken.path, null);
    assert.equal(broken.cleared, "unavailable");
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
