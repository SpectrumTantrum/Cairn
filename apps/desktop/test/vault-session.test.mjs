import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
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

test("listTree defaults to name sort and now carries mtime/size on files", () => {
  const vault = makeVaultDir();
  try {
    writeFileSync(join(vault, "b.md"), "# b\n");
    writeFileSync(join(vault, "a.md"), "# a\n");
    mkdirSync(join(vault, "sub"), { recursive: true });

    const session = createVaultSession();
    session.setVault(vault);

    // No sort arg ⇒ name order, byte-identical to an explicit "name" listing.
    const def = session.listTree();
    const named = session.listTree("", "name");
    assert.deepEqual(def.map((n) => n.name), ["sub", "a.md", "b.md"]);
    assert.deepEqual(def.map((n) => n.name), named.map((n) => n.name));

    // Files carry the mtime/size sort keys (even in name mode); folders omit them.
    const file = def.find((n) => n.name === "a.md");
    assert.equal(typeof file.mtime, "number");
    assert.equal(typeof file.size, "number");
    const folder = def.find((n) => n.name === "sub");
    assert.equal(folder.mtime, undefined);
    assert.equal(folder.size, undefined);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("listTree mtime sort orders files newest-first, folders still first", () => {
  const vault = makeVaultDir();
  try {
    mkdirSync(join(vault, "zeta-folder"), { recursive: true });
    writeFileSync(join(vault, "old.md"), "# old\n");
    writeFileSync(join(vault, "mid.md"), "# mid\n");
    writeFileSync(join(vault, "new.md"), "# new\n");
    // Deterministic, distinct mtimes (atime, mtime) in epoch seconds.
    utimesSync(join(vault, "old.md"), 1000, 1000);
    utimesSync(join(vault, "mid.md"), 2000, 2000);
    utimesSync(join(vault, "new.md"), 3000, 3000);

    const session = createVaultSession();
    session.setVault(vault);
    const tree = session.listTree("", "mtime");

    // Folder leads (omits mtime), then files sorted most-recently-modified first.
    assert.deepEqual(tree.map((n) => n.name), ["zeta-folder", "new.md", "mid.md", "old.md"]);
    assert.equal(tree[0].type, "folder");
    assert.equal(typeof tree[1].mtime, "number");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("listTree size sort orders files largest-first, folders still first", () => {
  const vault = makeVaultDir();
  try {
    mkdirSync(join(vault, "afolder"), { recursive: true });
    writeFileSync(join(vault, "small.md"), "x"); // 1 byte
    writeFileSync(join(vault, "large.md"), "x".repeat(100)); // 100 bytes
    writeFileSync(join(vault, "medium.md"), "x".repeat(10)); // 10 bytes

    const session = createVaultSession();
    session.setVault(vault);
    const tree = session.listTree("", "size");

    assert.deepEqual(tree.map((n) => n.name), ["afolder", "large.md", "medium.md", "small.md"]);
    assert.equal(tree[0].type, "folder");
    assert.equal(tree[1].size, 100);
    assert.equal(tree[3].size, 1);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("listTree keeps folders in name order even in mtime mode", () => {
  const vault = makeVaultDir();
  try {
    mkdirSync(join(vault, "b-folder"), { recursive: true });
    mkdirSync(join(vault, "a-folder"), { recursive: true });
    writeFileSync(join(vault, "note.md"), "# n\n");
    // Make b-folder's dir mtime the newest; folders must ignore it and stay name-ordered.
    utimesSync(join(vault, "b-folder"), 9999, 9999);
    utimesSync(join(vault, "a-folder"), 1, 1);

    const session = createVaultSession();
    session.setVault(vault);
    const tree = session.listTree("", "mtime");

    assert.deepEqual(tree.map((n) => n.name), ["a-folder", "b-folder", "note.md"]);
    assert.equal(tree[0].mtime, undefined);
    assert.equal(tree[0].size, undefined);
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

test("writeSource rejects writing through a dangling-leaf .md symlink pointing outside the vault", () => {
  // The proven exploit: a `.md` file inside the vault that is ITSELF a symlink to a
  // not-yet-existing path outside the vault. existsSync(target) is false (dangling),
  // so the old ancestor-realpath probe walked up to the in-vault parent and let the
  // write escape through the link, creating an arbitrary file outside the vault.
  const vault = makeVaultDir();
  const outside = makeVaultDir();
  try {
    const outsideTarget = join(outside, "pwned.md");
    symlinkSync(outsideTarget, join(vault, "evil.md"));
    const session = createVaultSession();
    session.setVault(vault);
    assert.throws(
      () => session.writeSource("evil.md", "PWNED"),
      /Refusing to write through a symbolic link/,
    );
    // The escape must NOT have happened: no file was created outside the vault.
    assert.equal(existsSync(outsideTarget), false, "must not write through the symlink");
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("writeSource rejects writing into the .cairn index directory", () => {
  const vault = makeVaultDir();
  try {
    const session = createVaultSession();
    session.setVault(vault);
    assert.throws(
      () => session.writeSource(".cairn/foo.md", "x"),
      /Refusing to write inside the .cairn index directory/,
    );
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

// ============================================================================
// Vault mutations (issue #21) — create / rename / delete / move.
// Every op funnels through the same write-gate as source:write. The security
// tests below mirror the source:write escape-attempt cases for EACH op: lexical
// `../` traversal, a symlinked leaf, a symlinked intermediate dir, and a
// `.cairn/` target. Creation/rename/move deliberately allow any extension
// (ADR-0009: index & cite everything) — only in-app *editing* stays Markdown-only.
// ============================================================================

/** Run `fn(session, vault)` against a fresh vault dir, cleaning up afterward. */
function withVault(fn) {
  const vault = makeVaultDir();
  try {
    const session = createVaultSession();
    session.setVault(vault);
    fn(session, vault);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

/** Like `withVault`, but also provisions a second dir OUTSIDE the vault (symlink targets). */
function withVaultAndOutside(fn) {
  const vault = makeVaultDir();
  const outside = makeVaultDir();
  try {
    const session = createVaultSession();
    session.setVault(vault);
    fn(session, vault, outside);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}

// ---- Happy paths -----------------------------------------------------------

test("createFile creates an empty vault-relative file", () => {
  withVault((session, vault) => {
    session.createFile("new-note.md");
    assert.equal(existsSync(join(vault, "new-note.md")), true);
    assert.equal(session.readSource("new-note.md"), "");
  });
});

test("createFile allows non-Markdown extensions (ADR-0009 index-everything)", () => {
  withVault((session, vault) => {
    session.createFile("data.csv");
    assert.equal(existsSync(join(vault, "data.csv")), true);
  });
});

test("createFile refuses to clobber an existing entry", () => {
  withVault((session) => {
    session.createFile("dup.md");
    assert.throws(() => session.createFile("dup.md"), /A file or folder with that name already exists/);
  });
});

test("createFolder creates a vault-relative folder", () => {
  withVault((session, vault) => {
    session.createFolder("projects");
    assert.equal(statSync(join(vault, "projects")).isDirectory(), true);
  });
});

test("createFolder refuses to clobber an existing entry", () => {
  withVault((session) => {
    session.createFolder("dir");
    assert.throws(() => session.createFolder("dir"), /A file or folder with that name already exists/);
  });
});

test("rename moves a file to a new basename in the same parent", () => {
  withVault((session, vault) => {
    session.createFile("old.md");
    session.rename("old.md", "new.md");
    assert.equal(existsSync(join(vault, "old.md")), false);
    assert.equal(existsSync(join(vault, "new.md")), true);
  });
});

test("rename refuses to overwrite an existing destination", () => {
  withVault((session) => {
    session.createFile("a.md");
    session.createFile("b.md");
    assert.throws(() => session.rename("a.md", "b.md"), /A file or folder with that name already exists/);
  });
});

test("rename reports a friendly error when the source is missing", () => {
  withVault((session) => {
    assert.throws(() => session.rename("ghost.md", "x.md"), /The source file is no longer available/);
  });
});

test("move relocates a file into an existing subfolder", () => {
  withVault((session, vault) => {
    session.createFolder("inbox");
    session.createFile("loose.md");
    session.move("loose.md", "inbox/loose.md");
    assert.equal(existsSync(join(vault, "loose.md")), false);
    assert.equal(existsSync(join(vault, "inbox", "loose.md")), true);
  });
});

test("deletePath removes a file", () => {
  withVault((session, vault) => {
    session.createFile("trash.md");
    session.deletePath("trash.md");
    assert.equal(existsSync(join(vault, "trash.md")), false);
  });
});

test("deletePath removes a folder recursively", () => {
  withVault((session, vault) => {
    session.createFolder("folder");
    session.createFile("folder/inner.md");
    session.deletePath("folder");
    assert.equal(existsSync(join(vault, "folder")), false);
  });
});

test("deletePath reports a friendly error when the target is missing", () => {
  withVault((session) => {
    assert.throws(() => session.deletePath("nope.md"), /The source file is no longer available/);
  });
});

// ---- createFile security ---------------------------------------------------

test("createFile rejects a lexical ../ traversal", () => {
  withVault((session) => {
    assert.throws(() => session.createFile("../escape.md"), /Refusing to open a path outside/);
  });
});

test("createFile rejects a symlinked leaf pointing outside the vault", () => {
  withVaultAndOutside((session, vault, outside) => {
    const outsideTarget = join(outside, "pwned.md");
    symlinkSync(outsideTarget, join(vault, "evil.md"));
    assert.throws(() => session.createFile("evil.md"), /Refusing to write through a symbolic link/);
    assert.equal(existsSync(outsideTarget), false, "must not create through the symlink");
  });
});

test("createFile rejects a symlinked intermediate directory escaping the vault", () => {
  withVaultAndOutside((session, vault, outside) => {
    symlinkSync(outside, join(vault, "escape"));
    assert.throws(() => session.createFile("escape/new.md"), /Refusing to write a path outside/);
    assert.equal(existsSync(join(outside, "new.md")), false);
  });
});

test("createFile rejects a target inside the .cairn index directory", () => {
  withVault((session) => {
    assert.throws(() => session.createFile(".cairn/foo.md"), /Refusing to write inside the .cairn index directory/);
  });
});

// ---- createFolder security -------------------------------------------------

test("createFolder rejects a lexical ../ traversal", () => {
  withVault((session) => {
    assert.throws(() => session.createFolder("../escape"), /Refusing to open a path outside/);
  });
});

test("createFolder rejects a symlinked leaf", () => {
  withVaultAndOutside((session, vault, outside) => {
    symlinkSync(outside, join(vault, "linkdir"));
    assert.throws(() => session.createFolder("linkdir"), /Refusing to write through a symbolic link/);
  });
});

test("createFolder rejects a symlinked intermediate directory escaping the vault", () => {
  withVaultAndOutside((session, vault, outside) => {
    symlinkSync(outside, join(vault, "escape"));
    assert.throws(() => session.createFolder("escape/child"), /Refusing to write a path outside/);
    assert.equal(existsSync(join(outside, "child")), false);
  });
});

test("createFolder rejects a target inside the .cairn index directory", () => {
  withVault((session) => {
    assert.throws(() => session.createFolder(".cairn/sub"), /Refusing to write inside the .cairn index directory/);
  });
});

// ---- rename security (destination validated the same as create) ------------

test("rename rejects a ../ traversal destination", () => {
  withVault((session) => {
    session.createFile("note.md");
    assert.throws(() => session.rename("note.md", "../escape.md"), /Refusing to open a path outside/);
  });
});

test("rename rejects a symlinked-leaf destination", () => {
  withVaultAndOutside((session, vault, outside) => {
    session.createFile("note.md");
    symlinkSync(join(outside, "pwned.md"), join(vault, "evil.md"));
    assert.throws(() => session.rename("note.md", "evil.md"), /Refusing to write through a symbolic link/);
  });
});

test("rename rejects a destination through a symlinked intermediate directory", () => {
  withVaultAndOutside((session, vault, outside) => {
    session.createFile("note.md");
    symlinkSync(outside, join(vault, "escape"));
    assert.throws(() => session.rename("note.md", "escape/note.md"), /Refusing to write a path outside/);
    assert.equal(existsSync(join(outside, "note.md")), false);
  });
});

test("rename rejects a .cairn destination", () => {
  withVault((session) => {
    session.createFile("note.md");
    assert.throws(() => session.rename("note.md", ".cairn/note.md"), /Refusing to write inside the .cairn index directory/);
  });
});

// ---- move security (same gate as rename) -----------------------------------

test("move rejects a ../ traversal destination", () => {
  withVault((session) => {
    session.createFile("note.md");
    assert.throws(() => session.move("note.md", "../escape.md"), /Refusing to open a path outside/);
  });
});

test("move rejects a symlinked-leaf destination", () => {
  withVaultAndOutside((session, vault, outside) => {
    session.createFile("note.md");
    symlinkSync(join(outside, "pwned.md"), join(vault, "evil.md"));
    assert.throws(() => session.move("note.md", "evil.md"), /Refusing to write through a symbolic link/);
  });
});

test("move rejects a destination through a symlinked intermediate directory", () => {
  withVaultAndOutside((session, vault, outside) => {
    session.createFile("note.md");
    symlinkSync(outside, join(vault, "escape"));
    assert.throws(() => session.move("note.md", "escape/note.md"), /Refusing to write a path outside/);
    assert.equal(existsSync(join(outside, "note.md")), false);
  });
});

test("move rejects a .cairn destination", () => {
  withVault((session) => {
    session.createFile("note.md");
    assert.throws(() => session.move("note.md", ".cairn/note.md"), /Refusing to write inside the .cairn index directory/);
  });
});

// ---- delete security -------------------------------------------------------

test("deletePath rejects a ../ traversal", () => {
  withVault((session) => {
    assert.throws(() => session.deletePath("../escape.md"), /Refusing to open a path outside/);
  });
});

test("deletePath rejects a symlinked leaf (never deletes through a link)", () => {
  withVaultAndOutside((session, vault, outside) => {
    const outsideTarget = join(outside, "keep.md");
    writeFileSync(outsideTarget, "keep me\n");
    symlinkSync(outsideTarget, join(vault, "evil.md"));
    assert.throws(() => session.deletePath("evil.md"), /Refusing to write through a symbolic link/);
    assert.equal(existsSync(outsideTarget), true, "must not delete the symlink's target");
  });
});

test("deletePath rejects a target through a symlinked intermediate directory", () => {
  withVaultAndOutside((session, vault, outside) => {
    writeFileSync(join(outside, "victim.md"), "x\n");
    symlinkSync(outside, join(vault, "escape"));
    assert.throws(() => session.deletePath("escape/victim.md"), /Refusing to write a path outside/);
    assert.equal(existsSync(join(outside, "victim.md")), true);
  });
});

test("deletePath rejects a target inside the .cairn index directory", () => {
  withVault((session, vault) => {
    mkdirSync(join(vault, ".cairn"), { recursive: true });
    writeFileSync(join(vault, ".cairn", "index.db"), "");
    assert.throws(() => session.deletePath(".cairn/index.db"), /Refusing to write inside the .cairn index directory/);
    assert.equal(existsSync(join(vault, ".cairn", "index.db")), true);
  });
});
