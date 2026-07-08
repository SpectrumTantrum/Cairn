import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const { createVaultSession } = await import("../out-test/vault-session.js");
const { InMemoryIndex } = await import("@cairn/engine/testing");

function makeVaultDir() {
  return mkdtempSync(join(tmpdir(), "cairn-vault-session-"));
}

test("search throws when no vault is selected", async () => {
  const session = createVaultSession({ openIndex: () => new InMemoryIndex() });
  await assert.rejects(() => session.search("query"), /Choose a vault folder first/);
});

test("search throws when the vault is not indexed", async () => {
  const vault = makeVaultDir();
  try {
    const session = createVaultSession({ openIndex: () => new InMemoryIndex(vault) });
    session.setVault(vault);
    await assert.rejects(() => session.search("query"), /Index this vault before searching/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("resolveSourcePath rejects paths outside the vault", () => {
  const vault = makeVaultDir();
  try {
    const session = createVaultSession();
    session.setVault(vault);
    assert.throws(() => session.resolveSourcePath("../outside.md"), /Refusing to open a path outside/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("resolveSourcePath returns an absolute path inside the vault", () => {
  const vault = makeVaultDir();
  try {
    writeFileSync(join(vault, "note.md"), "# Note\n");
    const session = createVaultSession();
    session.setVault(vault);
    assert.equal(session.resolveSourcePath("note.md"), realpathSync(resolve(vault, "note.md")));
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("readSource returns the file contents for a vault-relative path", () => {
  const vault = makeVaultDir();
  try {
    writeFileSync(join(vault, "note.md"), "# Note\n\nBody line.\n");
    const session = createVaultSession();
    session.setVault(vault);
    assert.equal(session.readSource("note.md"), "# Note\n\nBody line.\n");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("readSource rejects paths outside the vault", () => {
  const vault = makeVaultDir();
  try {
    const session = createVaultSession();
    session.setVault(vault);
    assert.throws(() => session.readSource("../outside.md"), /Refusing to open a path outside/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("readSource reports a friendly error for a missing file", () => {
  const vault = makeVaultDir();
  try {
    const session = createVaultSession();
    session.setVault(vault);
    assert.throws(() => session.readSource("gone.md"), /The source file is no longer available/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("readSource refuses to read a directory", () => {
  const vault = makeVaultDir();
  try {
    mkdirSync(join(vault, "subdir"), { recursive: true });
    const session = createVaultSession();
    session.setVault(vault);
    assert.throws(() => session.readSource("subdir"), /The source file is no longer available/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("search uses the injected Index adapter when indexed", async () => {
  const vault = makeVaultDir();
  try {
    mkdirSync(join(vault, ".cairn"), { recursive: true });
    writeFileSync(join(vault, ".cairn", "index.db"), "");

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
          text: "Cairn keeps Markdown vaults local.",
          hash: "h1",
        },
      ],
    });

    const session = createVaultSession({
      openIndex: () => index,
    });
    session.setVault(vault);

    const hits = await session.search("Markdown vaults");
    assert.ok(hits.length > 0);
    assert.equal(hits[0].file, "note.md");
    index.close();
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
