import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const { createVaultSession } = await import("../out-test/vault-session.js");
const { InMemoryIndex, FakeModelProvider } = await import("@cairn/engine/testing");
const { setModelProvider, resetModelProvider } = await import("@cairn/engine");

function makeVaultDir() {
  return mkdtempSync(join(tmpdir(), "cairn-vault-session-"));
}

/** A vault dir with an on-disk index.db marker so `assertIndexed` passes. */
function makeIndexedVaultDir() {
  const vault = makeVaultDir();
  mkdirSync(join(vault, ".cairn"), { recursive: true });
  writeFileSync(join(vault, ".cairn", "index.db"), "");
  return vault;
}

/** A fresh lexical InMemoryIndex holding one chunk per (file, text) pair. */
function buildLexicalIndex(vault, entries) {
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

test("listTree ignores .cairn and dotfiles and sorts folders before files", () => {
  const vault = makeVaultDir();
  try {
    mkdirSync(join(vault, ".cairn"), { recursive: true });
    writeFileSync(join(vault, ".cairn", "index.db"), "");
    writeFileSync(join(vault, ".hidden"), "secret\n");
    mkdirSync(join(vault, ".git"), { recursive: true });
    mkdirSync(join(vault, "02-projects"), { recursive: true });
    mkdirSync(join(vault, "01-courses"), { recursive: true });
    writeFileSync(join(vault, "01-courses", "algebra.md"), "# Algebra\n");
    writeFileSync(join(vault, "readme.md"), "# Readme\n");
    writeFileSync(join(vault, "notes.txt"), "plain\n");

    const session = createVaultSession();
    session.setVault(vault);
    const tree = session.listTree();

    // No dotfiles / .cairn / .git surfaced anywhere at the top level.
    const names = tree.map((n) => n.name);
    assert.deepEqual(names, ["01-courses", "02-projects", "notes.txt", "readme.md"]);

    // Folders come first (natural order), then files (alpha).
    assert.equal(tree[0].type, "folder");
    assert.equal(tree[1].type, "folder");
    assert.equal(tree[2].type, "other"); // notes.txt is a non-markdown node
    assert.equal(tree[3].type, "markdown"); // readme.md

    // Nested markdown is discovered and carries a vault-relative POSIX path.
    const courses = tree.find((n) => n.name === "01-courses");
    assert.equal(courses.children.length, 1);
    assert.equal(courses.children[0].path, "01-courses/algebra.md");
    assert.equal(courses.children[0].type, "markdown");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("listTree rejects listing a path outside the vault", () => {
  const vault = makeVaultDir();
  try {
    const session = createVaultSession();
    session.setVault(vault);
    assert.throws(() => session.listTree("../"), /Refusing to open a path outside/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("listTree throws when no vault is selected", () => {
  const session = createVaultSession();
  assert.throws(() => session.listTree(), /Choose a vault folder first/);
});

test("writeSource round-trips content for a vault-relative markdown path", () => {
  const vault = makeVaultDir();
  try {
    const session = createVaultSession();
    session.setVault(vault);
    session.writeSource("note.md", "# Edited\n\nNew body.\n");
    assert.equal(session.readSource("note.md"), "# Edited\n\nNew body.\n");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("writeSource rejects paths that traverse outside the vault", () => {
  const vault = makeVaultDir();
  try {
    const session = createVaultSession();
    session.setVault(vault);
    assert.throws(() => session.writeSource("../escape.md", "x"), /Refusing to open a path outside/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("writeSource rejects non-markdown files", () => {
  const vault = makeVaultDir();
  try {
    const session = createVaultSession();
    session.setVault(vault);
    assert.throws(() => session.writeSource("note.txt", "x"), /Refusing to write a non-Markdown file/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("writeSource rejects writes that escape the vault through a symlink", () => {
  const vault = makeVaultDir();
  const outside = makeVaultDir();
  try {
    // A symlinked directory inside the vault pointing outside it.
    symlinkSync(outside, join(vault, "escape"));
    const session = createVaultSession();
    session.setVault(vault);
    assert.throws(
      () => session.writeSource("escape/evil.md", "x"),
      /Refusing to write a path outside/,
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
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

test("chatSend rejects an empty question", async () => {
  const vault = makeIndexedVaultDir();
  try {
    const session = createVaultSession({ openIndex: (v) => new InMemoryIndex(v) });
    session.setVault(vault);
    await assert.rejects(() => session.chatSend("   "), /Ask needs a question/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("chatSend throws when no vault is selected", async () => {
  const session = createVaultSession({ openIndex: (v) => new InMemoryIndex(v) });
  await assert.rejects(() => session.chatSend("hello"), /Choose a vault folder first/);
});

test("chatSend throws when the vault is not indexed", async () => {
  const vault = makeVaultDir();
  try {
    const session = createVaultSession({ openIndex: (v) => new InMemoryIndex(v) });
    session.setVault(vault);
    await assert.rejects(() => session.chatSend("hello"), /Index this vault before/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("chatSend threads the selected model through to the result", async () => {
  const vault = makeIndexedVaultDir();
  setModelProvider(new FakeModelProvider({ models: ["qwen3:4b", "test-embedder"] }));
  try {
    const session = createVaultSession({
      openIndex: (v) => buildLexicalIndex(v, [{ file: "a.md", text: "markdown vault notes" }]),
    });
    session.setVault(vault);
    const result = await session.chatSend("markdown vault", { model: "qwen3:4b" });
    assert.equal(result.model, "qwen3:4b");
    assert.equal(result.covered, true);
  } finally {
    resetModelProvider();
    rmSync(vault, { recursive: true, force: true });
  }
});

test("chatSend rejects a model that is not pulled", async () => {
  const vault = makeIndexedVaultDir();
  setModelProvider(new FakeModelProvider({ models: ["qwen3:4b"] }));
  try {
    const session = createVaultSession({
      openIndex: (v) => buildLexicalIndex(v, [{ file: "a.md", text: "markdown vault notes" }]),
    });
    session.setVault(vault);
    await assert.rejects(() => session.chatSend("markdown vault", { model: "missing:70b" }), /not pulled/);
  } finally {
    resetModelProvider();
    rmSync(vault, { recursive: true, force: true });
  }
});

test("chatSend threads the source scope into retrieval", async () => {
  const vault = makeIndexedVaultDir();
  setModelProvider(new FakeModelProvider({ models: ["qwen3:4b"] }));
  try {
    const session = createVaultSession({
      openIndex: (v) =>
        buildLexicalIndex(v, [
          { file: "a.md", text: "alpha markdown vault notes" },
          { file: "b.md", text: "beta markdown vault notes" },
        ]),
    });
    session.setVault(vault);

    const unscoped = await session.chatSend("markdown vault");
    const unscopedFiles = new Set(unscoped.sources.map((s) => s.file));
    assert.ok(unscopedFiles.has("a.md") && unscopedFiles.has("b.md"));

    const scoped = await session.chatSend("markdown vault", { scope: ["a.md"] });
    assert.ok(scoped.sources.length > 0);
    assert.ok(scoped.sources.every((s) => s.file === "a.md"));
  } finally {
    resetModelProvider();
    rmSync(vault, { recursive: true, force: true });
  }
});

test("chat history grows across turns and resets after resetChat", async () => {
  const vault = makeIndexedVaultDir();
  const calls = [];
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chat: async (_model, messages) => {
        calls.push(messages);
        return "Grounded answer [1].";
      },
    }),
  );
  try {
    const session = createVaultSession({
      openIndex: (v) => buildLexicalIndex(v, [{ file: "a.md", text: "markdown vault notes" }]),
    });
    session.setVault(vault);

    await session.chatSend("first question about markdown");
    await session.chatSend("second question about vault");
    assert.equal(calls.length, 2);
    // Turn 2 carries the prior user+assistant turns as history → strictly more messages.
    assert.ok(calls[1].length > calls[0].length);

    session.resetChat();
    await session.chatSend("third question about markdown");
    assert.equal(calls.length, 3);
    // A fresh thread has no history, so it matches the first turn's message count.
    assert.equal(calls[2].length, calls[0].length);
  } finally {
    resetModelProvider();
    rmSync(vault, { recursive: true, force: true });
  }
});
