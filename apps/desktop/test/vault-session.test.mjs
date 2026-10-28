import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const { createVaultSession } = await import("../out-test/vault-session.js");
const { couldntFindVaultMessage } = await import("../out-test/vault-open.js");
const { InMemoryIndex, FakeModelProvider } = await import("@cairn/engine/testing");
const { setModelProvider, resetModelProvider, AUDIO_NO_TEXT, IMAGE_NO_TEXT, VIDEO_NO_TEXT } = await import("@cairn/engine");
const imageFixtures = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/engine/test/fixtures/images");
const audioFixtures = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/engine/test/fixtures/audio");
const videoFixtures = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/engine/test/fixtures/video");

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

test("setVault says Couldn't find for a missing folder, a file, and an unreadable folder", () => {
  const session = createVaultSession();
  assert.throws(() => session.setVault("  "), /Choose a vault folder first\./);

  const dir = makeVaultDir();
  const missing = join(dir, "gone");
  const file = join(dir, "note.md");
  writeFileSync(file, "x\n");
  try {
    assert.throws(
      () => session.setVault(missing),
      (err) => err instanceof Error && err.message === couldntFindVaultMessage(resolve(missing)),
    );
    assert.throws(
      () => session.setVault(file),
      (err) => err instanceof Error && err.message === couldntFindVaultMessage(resolve(file)),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setVault says Couldn't find for a chmod 000 folder", { skip: process.getuid?.() === 0 }, () => {
  const vault = makeVaultDir();
  try {
    chmodSync(vault, 0o000);
    const session = createVaultSession();
    assert.throws(
      () => session.setVault(vault),
      (err) => err instanceof Error && err.message === couldntFindVaultMessage(resolve(vault)),
    );
  } finally {
    chmodSync(vault, 0o755);
    rmSync(vault, { recursive: true, force: true });
  }
});

test("openVault reads an existing index once and returns those stats", async () => {
  const vault = makeIndexedVaultDir();
  let reads = 0;
  try {
    const session = createVaultSession({
      openIndex: () => {
        reads += 1;
        return buildLexicalIndex(vault, [{ file: "note.md", text: "alpha finch" }]);
      },
    });
    const first = session.openVault(vault);
    const second = session.openVault(vault);
    const [opened, again] = await Promise.all([first, second]);
    assert.equal(reads, 1);
    assert.equal(opened.path, realpathSync(vault));
    assert.equal(opened.index?.mode, "lexical");
    assert.equal(opened.index?.files, 1);
    assert.equal(opened.index?.chunks, 1);
    assert.equal(again.index?.chunks, 1);
    const third = await session.openVault(vault);
    assert.equal(reads, 1);
    assert.equal(third.index?.files, 1);

    const other = makeVaultDir();
    try {
      const bare = await session.openVault(other);
      assert.equal(bare.index, null);
      assert.equal(reads, 1);
      await session.openVault(vault);
      assert.equal(reads, 2);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
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

test("readSource returns visible HTML text and refuses empty or non-UTF-8 html", () => {
  const vault = makeVaultDir();
  try {
    writeFileSync(
      join(vault, "section-b.html"),
      "<h2>Section B</h2><p>The field code is COPPER FINCH, 312 under Section B.</p><script>secret</script>",
    );
    writeFileSync(join(vault, "empty.html"), "<html><body><script>only</script></body></html>");
    writeFileSync(join(vault, "junk.html"), Buffer.from([0xff, 0xfe, 0x00]));
    const session = createVaultSession();
    session.setVault(vault);
    const text = session.readSource("section-b.html");
    assert.match(text, /## Section B/);
    assert.match(text, /COPPER FINCH, 312/);
    assert.equal(text.includes("secret"), false);
    assert.equal(text.includes("<"), false);
    assert.throws(() => session.readSource("empty.html"), /no readable text/);
    assert.throws(() => session.readSource("junk.html"), /not valid UTF-8/);
    assert.throws(() => session.writeSource("section-b.html", "x"), /Refusing to write a non-Markdown file/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("readSource returns raw CSV and TSV rows and refuses empty or non-UTF-8 tables", () => {
  const vault = makeVaultDir();
  try {
    writeFileSync(
      join(vault, "section-b.csv"),
      'section,code,note\nSection B,COPPER FINCH,"The field code is COPPER FINCH, 312 under Section B."\n',
    );
    writeFileSync(join(vault, "rows.tsv"), "section\tnote\nAlias\tThe tsv marker is BLUE JAY.\n");
    writeFileSync(join(vault, "empty.csv"), "\n");
    writeFileSync(join(vault, "junk.csv"), Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x41]));
    const session = createVaultSession();
    session.setVault(vault);
    const csv = session.readSource("section-b.csv");
    assert.match(csv, /^section,code,note/m);
    assert.match(csv, /COPPER FINCH, 312/);
    assert.match(session.readSource("rows.tsv"), /BLUE JAY/);
    assert.match(session.readSource("rows.tsv"), /section\tnote/);
    assert.throws(() => session.readSource("empty.csv"), /empty, so Cairn cannot read it/);
    assert.throws(() => session.readSource("junk.csv"), /not valid UTF-8/);
    assert.throws(() => session.writeSource("section-b.csv", "x"), /Refusing to write a non-Markdown file/);
    assert.throws(() => session.writeSource("rows.tsv", "x"), /Refusing to write a non-Markdown file/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("readImage opens a real image and readSource refuses to decode it as text", () => {
  const vault = makeVaultDir();
  try {
    const session = createVaultSession();
    session.setVault(vault);
    const names = ["section-b.png", "field.jpg", "field.jpeg", "mark.webp", "badge.gif"];
    for (const name of names) copyFileSync(join(imageFixtures, name), join(vault, name));
    writeFileSync(join(vault, "project-heron.md"), "# Project Heron\n\nCOPPER FINCH\n");

    const tree = session.listTree();
    const pngNode = tree.find((node) => node.name === "section-b.png");
    assert.ok(pngNode);
    assert.equal(pngNode.type, "other");

    const opened = session.readImage("section-b.png");
    assert.equal(opened.mime, "image/png");
    assert.equal(opened.dataUrl.startsWith("data:image/png;base64,"), true);
    const raw = readFileSync(join(vault, "section-b.png"));
    assert.ok(raw.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
    assert.deepEqual(Buffer.from(opened.dataUrl.slice("data:image/png;base64,".length), "base64"), raw);

    assert.equal(session.readImage("field.jpg").mime, "image/jpeg");
    assert.equal(session.readImage("field.jpeg").mime, "image/jpeg");
    assert.equal(session.readImage("mark.webp").mime, "image/webp");
    assert.equal(session.readImage("badge.gif").mime, "image/gif");
    assert.equal(session.readImage("badge.gif").dataUrl.startsWith("data:image/gif;base64,"), true);

    assert.throws(() => session.readSource("section-b.png"), { message: IMAGE_NO_TEXT });
    assert.throws(() => session.readSource("gone.png"), /The source file is no longer available/);
    assert.throws(() => session.readImage("project-heron.md"), /Only an image can be opened/);
    assert.throws(() => session.readImage("../secret.png"), /Refusing to open a path outside/);
    assert.throws(() => session.writeSource("section-b.png", "x"), /Refusing to write a non-Markdown file/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("readAudio opens a real recording and readSource refuses to decode it as text", () => {
  const vault = makeVaultDir();
  try {
    const session = createVaultSession();
    session.setVault(vault);
    for (const name of ["section-b.mp3", "tone.wav", "clip.m4a"]) {
      copyFileSync(join(audioFixtures, name), join(vault, name));
    }
    writeFileSync(join(vault, "project-heron.md"), "# Project Heron\n");

    const tree = session.listTree();
    const mp3Node = tree.find((node) => node.name === "section-b.mp3");
    assert.ok(mp3Node);
    assert.equal(mp3Node.type, "other");

    const opened = session.readAudio("section-b.mp3");
    assert.equal(opened.mime, "audio/mpeg");
    assert.equal(opened.dataUrl.startsWith("data:audio/mpeg;base64,"), true);
    const raw = readFileSync(join(vault, "section-b.mp3"));
    assert.ok(raw.subarray(0, 3).equals(Buffer.from("ID3")));
    assert.deepEqual(Buffer.from(opened.dataUrl.slice("data:audio/mpeg;base64,".length), "base64"), raw);

    assert.equal(session.readAudio("tone.wav").mime, "audio/wav");
    assert.equal(session.readAudio("clip.m4a").mime, "audio/mp4");
    assert.equal(session.readAudio("tone.wav").dataUrl.startsWith("data:audio/wav;base64,"), true);

    assert.throws(() => session.readSource("section-b.mp3"), { message: AUDIO_NO_TEXT });
    assert.throws(() => session.readSource("gone.wav"), /The source file is no longer available/);
    assert.throws(() => session.readAudio("project-heron.md"), /Only an audio file can be opened/);
    assert.throws(() => session.readAudio("../secret.mp3"), /Refusing to open a path outside/);
    assert.throws(() => session.writeSource("section-b.mp3", "x"), /Refusing to write a non-Markdown file/);

    const csp = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../electron.vite.config.ts"), "utf8");
    assert.match(csp, /media-src 'self' data:/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("readVideo opens a real clip and readSource refuses to decode it as text", () => {
  const vault = makeVaultDir();
  try {
    const session = createVaultSession();
    session.setVault(vault);
    for (const name of ["clip.mp4", "tone.webm", "section-b.mov"]) {
      copyFileSync(join(videoFixtures, name), join(vault, name));
    }
    writeFileSync(join(vault, "project-heron.md"), "# Project Heron\n");

    const tree = session.listTree();
    const mp4Node = tree.find((node) => node.name === "clip.mp4");
    assert.ok(mp4Node);
    assert.equal(mp4Node.type, "other");

    const opened = session.readVideo("clip.mp4");
    assert.equal(opened.mime, "video/mp4");
    assert.equal(opened.dataUrl.startsWith("data:video/mp4;base64,"), true);
    const raw = readFileSync(join(vault, "clip.mp4"));
    assert.ok(raw.includes(Buffer.from("ftyp")));
    assert.deepEqual(Buffer.from(opened.dataUrl.slice("data:video/mp4;base64,".length), "base64"), raw);

    assert.equal(session.readVideo("tone.webm").mime, "video/webm");
    assert.equal(session.readVideo("section-b.mov").mime, "video/quicktime");
    assert.equal(session.readVideo("tone.webm").dataUrl.startsWith("data:video/webm;base64,"), true);

    assert.throws(() => session.readSource("clip.mp4"), { message: VIDEO_NO_TEXT });
    assert.throws(() => session.readSource("gone.mov"), /The source file is no longer available/);
    assert.throws(() => session.readVideo("project-heron.md"), /Only a video file can be opened/);
    assert.throws(() => session.readVideo("../secret.mp4"), /Refusing to open a path outside/);
    assert.throws(() => session.writeSource("clip.mp4", "x"), /Refusing to write a non-Markdown file/);

    const csp = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../electron.vite.config.ts"), "utf8");
    assert.match(csp, /media-src 'self' data:/);
    assert.equal(csp.includes("video-src"), false);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("askAgent that names video misses and does not cite the shared-codename note", async () => {
  const vault = makeIndexedVaultDir();
  const note = "# Project Heron\n\nThe notebook codename is COPPER FINCH and the badge is 999.\n";
  copyFileSync(join(videoFixtures, "clip.mp4"), join(vault, "clip.mp4"));
  writeFileSync(join(vault, "project-heron.md"), note);
  let calls = 0;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async (_model, _messages, _tools, turn) => {
        calls += 1;
        if (turn === 1) {
          return {
            content: "",
            toolCalls: [{ name: "read", arguments: { path: "project-heron.md" } }],
          };
        }
        return { content: note, toolCalls: [] };
      },
    }),
  );
  try {
    const session = createVaultSession({
      openIndex: (dir) => buildLexicalIndex(dir, [{ file: "project-heron.md", text: note }]),
    });
    session.setVault(vault);
    const result = await session.askAgent("What does clip.mp4 say about Project Heron?");
    assert.equal(calls, 0);
    assert.equal(result.answer, "Your notes don't cover this.");
    assert.equal(result.answer.includes("COPPER FINCH"), false);
    assert.deepEqual(result.sources, []);
    assert.deepEqual(result.opened, []);
    assert.equal(result.grounded, false);
  } finally {
    resetModelProvider();
    rmSync(vault, { recursive: true, force: true });
  }
});

test("askAgent that names audio misses and does not cite the shared-codename note", async () => {
  const vault = makeIndexedVaultDir();
  const note = "# Project Heron\n\nThe notebook codename is COPPER FINCH and the badge is 999.\n";
  copyFileSync(join(audioFixtures, "section-b.mp3"), join(vault, "section-b.mp3"));
  writeFileSync(join(vault, "project-heron.md"), note);
  let calls = 0;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async (_model, _messages, _tools, turn) => {
        calls += 1;
        if (turn === 1) {
          return {
            content: "",
            toolCalls: [{ name: "read", arguments: { path: "project-heron.md" } }],
          };
        }
        return { content: note, toolCalls: [] };
      },
    }),
  );
  try {
    const session = createVaultSession({
      openIndex: (dir) => buildLexicalIndex(dir, [{ file: "project-heron.md", text: note }]),
    });
    session.setVault(vault);
    const result = await session.askAgent("What does section-b.mp3 say about Project Heron?");
    assert.equal(calls, 0);
    assert.equal(result.answer, "Your notes don't cover this.");
    assert.equal(result.answer.includes("COPPER FINCH"), false);
    assert.deepEqual(result.sources, []);
    assert.deepEqual(result.opened, []);
    assert.equal(result.grounded, false);
  } finally {
    resetModelProvider();
    rmSync(vault, { recursive: true, force: true });
  }
});

test("askAgent that names an image misses and does not cite the shared-codename note", async () => {
  const vault = makeIndexedVaultDir();
  const note = "# Project Heron\n\nThe notebook codename is COPPER FINCH and the badge is 999.\n";
  copyFileSync(join(imageFixtures, "section-b.png"), join(vault, "section-b.png"));
  writeFileSync(join(vault, "project-heron.md"), note);
  let calls = 0;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatWithTools: async (_model, _messages, _tools, turn) => {
        calls += 1;
        if (turn === 1) {
          return {
            content: "",
            toolCalls: [{ name: "read", arguments: { path: "project-heron.md" } }],
          };
        }
        return { content: note, toolCalls: [] };
      },
    }),
  );
  try {
    const session = createVaultSession({
      openIndex: (dir) => buildLexicalIndex(dir, [{ file: "project-heron.md", text: note }]),
    });
    session.setVault(vault);
    const result = await session.askAgent("What does section-b.png show about Project Heron?");
    assert.equal(calls, 0);
    assert.equal(result.answer, "Your notes don't cover this.");
    assert.equal(result.answer.includes("COPPER FINCH"), false);
    assert.deepEqual(result.sources, []);
    assert.deepEqual(result.opened, []);
    assert.equal(result.grounded, false);
  } finally {
    resetModelProvider();
    rmSync(vault, { recursive: true, force: true });
  }
});

test("readSource returns UTF-8 text and refuses a non-UTF-8 txt", () => {
  const vault = makeVaultDir();
  try {
    writeFileSync(join(vault, "notes.txt"), "# Section B\n\nThe field code is COPPER FINCH, 312.\n");
    writeFileSync(join(vault, "junk.txt"), Buffer.from([0xff, 0xfe, 0x00]));
    const session = createVaultSession();
    session.setVault(vault);
    assert.match(session.readSource("notes.txt"), /COPPER FINCH, 312/);
    assert.throws(() => session.readSource("junk.txt"), /not valid UTF-8/);
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

test("reindex does not cancel an in-flight agentic ask", async () => {
  const vault = makeIndexedVaultDir();
  writeFileSync(join(vault, "notes.md"), "Spaced repetition schedules reviews.\n");
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const enteredGate = new Promise((resolve) => {
    entered = resolve;
  });
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:8b"],
      chatWithTools: async (_model, _messages, _tools, turn, options) => {
        if (turn === 1) {
          entered();
          await gate;
          if (options?.signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
          }
          return { content: "", toolCalls: [{ name: "grep", arguments: { pattern: "reviews" } }] };
        }
        return { content: "Reviews happen at intervals.", toolCalls: [] };
      },
    }),
  );
  try {
    const session = createVaultSession({
      openIndex: (v) =>
        buildLexicalIndex(v, [{ file: "notes.md", text: "Spaced repetition schedules reviews." }]),
    });
    session.setVault(vault);
    const pending = session.askAgent("When are reviews scheduled?");
    await enteredGate;
    const stats = await session.index({ lexical: true });
    assert.equal(stats.mode, "lexical");
    assert.ok(stats.files >= 1);
    release();
    const result = await pending;
    assert.equal(result.stopReason, "done");
    assert.equal(result.answer, "Reviews happen at intervals.");
    assert.ok(result.sources.length > 0);
  } finally {
    release();
    resetModelProvider();
    rmSync(vault, { recursive: true, force: true });
  }
});

test("resetChat cancels an in-flight agentic ask", async () => {
  const vault = makeIndexedVaultDir();
  writeFileSync(join(vault, "notes.md"), "Spaced repetition schedules reviews.\n");
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const enteredGate = new Promise((resolve) => {
    entered = resolve;
  });
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:8b"],
      chatWithTools: async (_model, _messages, _tools, turn, options) => {
        if (turn === 1) {
          entered();
          await gate;
          if (options?.signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
          }
          return { content: "", toolCalls: [{ name: "grep", arguments: { pattern: "reviews" } }] };
        }
        return { content: "Reviews happen at intervals.", toolCalls: [] };
      },
    }),
  );
  try {
    const session = createVaultSession({
      openIndex: (v) =>
        buildLexicalIndex(v, [{ file: "notes.md", text: "Spaced repetition schedules reviews." }]),
    });
    session.setVault(vault);
    const pending = session.askAgent("When are reviews scheduled?");
    await enteredGate;
    session.resetChat();
    release();
    const result = await pending;
    assert.equal(result.stopReason, "cancelled");
    assert.equal(result.answer, "");
    assert.equal(result.sources.length, 0);
    assert.deepEqual(result.opened, []);
  } finally {
    release();
    resetModelProvider();
    rmSync(vault, { recursive: true, force: true });
  }
});

test("stopGenerating cancels a classic stream without keeping it in history, and the next ask works", async () => {
  const vault = makeIndexedVaultDir();
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const enteredGate = new Promise((resolve) => {
    entered = resolve;
  });
  const seen = [];
  let n = 0;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatStream: async (_model, messages, callbacks) => {
        n += 1;
        seen.push(messages.map((m) => m.content).join("\n"));
        if (n === 2) {
          entered();
          await gate;
          if (callbacks?.signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
          }
          return "should not finish";
        }
        return "Grounded answer [1].";
      },
    }),
  );
  try {
    const session = createVaultSession({
      openIndex: (v) => buildLexicalIndex(v, [{ file: "a.md", text: "markdown vault notes" }]),
    });
    session.setVault(vault);
    const first = await session.chatSend("markdown vault one", { onToken() {} });
    assert.equal(first.answer, "Grounded answer [1].");
    const pending = session.chatSend("markdown vault two", { onToken() {} });
    await enteredGate;
    session.stopGenerating();
    release();
    await assert.rejects(pending, (err) => err instanceof DOMException && err.name === "AbortError");
    const next = await session.chatSend("markdown vault three", { onToken() {} });
    assert.equal(next.answer, "Grounded answer [1].");
    assert.equal(next.sources.length > 0, true);
    assert.match(seen[2], /markdown vault one/);
    assert.match(seen[2], /Grounded answer/);
    assert.match(seen[2], /markdown vault three/);
    assert.equal(seen[2].includes("markdown vault two"), false);
  } finally {
    release();
    resetModelProvider();
    rmSync(vault, { recursive: true, force: true });
  }
});

test("a new ask started while stop is settling does not keep the cancelled question", async () => {
  const vault = makeIndexedVaultDir();
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const enteredGate = new Promise((resolve) => {
    entered = resolve;
  });
  const seen = [];
  let n = 0;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatStream: async (_model, messages, callbacks) => {
        n += 1;
        seen.push(messages.map((m) => m.content).join("\n"));
        if (n === 1) {
          entered();
          await gate;
          if (callbacks?.signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
          }
          return "should not finish";
        }
        return "Grounded answer [1].";
      },
    }),
  );
  try {
    const session = createVaultSession({
      openIndex: (v) => buildLexicalIndex(v, [{ file: "a.md", text: "markdown vault notes" }]),
    });
    session.setVault(vault);
    const pending = session.chatSend("markdown vault CANCEL", { onToken() {} });
    await enteredGate;
    session.stopGenerating();
    const next = session.chatSend("markdown vault NEXT", { onToken() {} });
    release();
    await assert.rejects(pending, (err) => err instanceof DOMException && err.name === "AbortError");
    const result = await next;
    assert.equal(result.answer, "Grounded answer [1].");
    assert.equal(seen.at(-1).includes("markdown vault CANCEL"), false);
    assert.match(seen.at(-1), /markdown vault NEXT/);
  } finally {
    release();
    resetModelProvider();
    rmSync(vault, { recursive: true, force: true });
  }
});

test("resetChat cancels an in-flight classic stream", async () => {
  const vault = makeIndexedVaultDir();
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const enteredGate = new Promise((resolve) => {
    entered = resolve;
  });
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:4b"],
      chatStream: async (_model, _messages, callbacks) => {
        entered();
        await gate;
        if (callbacks?.signal?.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        return "Grounded answer [1].";
      },
    }),
  );
  try {
    const session = createVaultSession({
      openIndex: (v) => buildLexicalIndex(v, [{ file: "a.md", text: "markdown vault notes" }]),
    });
    session.setVault(vault);
    const pending = session.chatSend("markdown vault", { onToken() {} });
    await enteredGate;
    session.resetChat();
    release();
    await assert.rejects(pending, (err) => err instanceof DOMException && err.name === "AbortError");
    const next = await session.chatSend("markdown vault", {
      onToken() {},
    });
    assert.equal(next.answer, "Grounded answer [1].");
  } finally {
    release();
    resetModelProvider();
    rmSync(vault, { recursive: true, force: true });
  }
});

test("stopGenerating cancels an in-flight agentic ask and the next ask works", async () => {
  const vault = makeIndexedVaultDir();
  writeFileSync(join(vault, "notes.md"), "Spaced repetition schedules reviews.\n");
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const enteredGate = new Promise((resolve) => {
    entered = resolve;
  });
  let n = 0;
  setModelProvider(
    new FakeModelProvider({
      models: ["qwen3:8b"],
      chatWithTools: async (_model, _messages, _tools, _turn, options) => {
        n += 1;
        if (n === 1) {
          entered();
          await gate;
          if (options?.signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
          }
          return { content: "", toolCalls: [{ name: "grep", arguments: { pattern: "reviews" } }] };
        }
        if (n === 2) return { content: "", toolCalls: [{ name: "grep", arguments: { pattern: "reviews" } }] };
        return { content: "Reviews happen at intervals.", toolCalls: [] };
      },
    }),
  );
  try {
    const session = createVaultSession({
      openIndex: (v) =>
        buildLexicalIndex(v, [{ file: "notes.md", text: "Spaced repetition schedules reviews." }]),
    });
    session.setVault(vault);
    const pending = session.askAgent("When are reviews scheduled?");
    await enteredGate;
    session.stopGenerating();
    release();
    const cancelled = await pending;
    assert.equal(cancelled.stopReason, "cancelled");
    assert.equal(cancelled.answer, "");
    assert.equal(cancelled.sources.length, 0);
    const next = await session.askAgent("When are reviews scheduled?");
    assert.equal(next.stopReason, "done");
    assert.equal(next.answer, "Reviews happen at intervals.");
    assert.ok(next.sources.length > 0);
  } finally {
    release();
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
