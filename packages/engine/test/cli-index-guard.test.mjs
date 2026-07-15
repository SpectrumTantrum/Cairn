// Guards for issue #39: `cairn index` must REQUIRE an explicit folder and never
// default to cwd (which silently pollutes arbitrary directories with a `.cairn/`
// sidecar). `search`/`ask` are read-only and keep the cwd default.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function runCli(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "cairn-cli-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("bare `cairn index` exits non-zero and creates no .cairn/", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "note.md"), "# Note\n\nBody text here.");
    const res = runCli(["index"], dir);
    assert.notEqual(res.status, 0, "bare index must exit non-zero");
    assert.match(
      res.stderr,
      /cairn index requires a folder argument/,
      "must print the explicit-folder usage message",
    );
    assert.equal(
      existsSync(join(dir, ".cairn")),
      false,
      "bare index must NOT create a .cairn/ sidecar in cwd",
    );
  });
});

test("`cairn index <folder> --lexical` still indexes the given folder", () => {
  withTempDir((home) => {
    const vault = mkdtempSync(join(tmpdir(), "cairn-vault-"));
    try {
      writeFileSync(join(vault, "note.md"), "# Note\n\nSpaced repetition body.");
      // cwd is `home` (not the vault) to prove the folder arg, not cwd, is used.
      const res = runCli(["index", vault, "--lexical"], home);
      assert.equal(res.status, 0, `index failed: ${res.stderr}`);
      assert.equal(
        existsSync(join(vault, ".cairn", "index.db")),
        true,
        "index.db must be created under the given folder",
      );
      assert.equal(
        existsSync(join(home, ".cairn")),
        false,
        "cwd must remain clean when an explicit folder is given",
      );
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});

test("`cairn index --in <folder>` counts as providing the folder", () => {
  withTempDir((home) => {
    const vault = mkdtempSync(join(tmpdir(), "cairn-vault-"));
    try {
      writeFileSync(join(vault, "note.md"), "# Note\n\nBody via --in flag.");
      const res = runCli(["index", "--in", vault, "--lexical"], home);
      assert.equal(res.status, 0, `index --in failed: ${res.stderr}`);
      assert.equal(existsSync(join(vault, ".cairn", "index.db")), true);
      assert.equal(existsSync(join(home, ".cairn")), false);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});

test("`cairn search` still defaults to cwd (read-only)", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "note.md"), "# Cache\n\nCache invalidation is hard.");
    // Build a lexical index in `dir`, then search from `dir` with no --in.
    const idx = runCli(["index", dir, "--lexical"], dir);
    assert.equal(idx.status, 0, `index failed: ${idx.stderr}`);
    const res = runCli(["search", "cache", "--lexical"], dir);
    assert.equal(res.status, 0, `search failed: ${res.stderr}`);
    assert.match(res.stdout, /note\.md/, "search should resolve the cwd index and cite the note");
  });
});

test("`cairn ask` still resolves to cwd (read-only)", () => {
  withTempDir((dir) => {
    // No index in cwd → ask must report it resolved to THIS dir's .cairn, proving
    // the cwd default is preserved for the read-only command.
    const res = runCli(["ask", "anything"], dir);
    assert.notEqual(res.status, 0);
    // On macOS the child's process.cwd() reports the realpath (/private/var/...),
    // while mkdtempSync hands back the /var/... symlink alias — resolve both.
    const resolved = realpathSync(dir).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(
      res.stderr,
      new RegExp(`No index at ${resolved}/\\.cairn`),
      "ask should default its vault root to cwd",
    );
    assert.equal(existsSync(join(dir, ".cairn")), false, "ask must not create .cairn/");
  });
});
