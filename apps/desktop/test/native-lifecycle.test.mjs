// Locks the desktop start/stop path to the Electron native rebuild, and checks
// that stopping the runner restores the Node ABI even when the child is signaled
// (npm does not run postdev/postpreview on SIGINT).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const { launchDesktop } = await import("../scripts/run-desktop.mjs");

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
);

test("root desktop scripts go through the workspace lifecycle", () => {
  const root = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8"),
  );
  assert.equal(root.scripts["desktop:dev"], "npm run dev --workspace @cairn/desktop");
  assert.equal(root.scripts["desktop:preview"], "npm run preview --workspace @cairn/desktop");
});

test("dev and preview rebuild for Electron and restore the Node ABI", () => {
  assert.match(pkg.scripts.predev, /rebuild-engine-native\.mjs electron/);
  assert.match(pkg.scripts.dev, /run-desktop\.mjs dev/);
  assert.match(pkg.scripts.postdev, /rebuild-engine-native\.mjs node/);
  assert.match(pkg.scripts.prepreview, /rebuild-engine-native\.mjs electron/);
  assert.match(pkg.scripts.preview, /run-desktop\.mjs preview/);
  assert.match(pkg.scripts.postpreview, /rebuild-engine-native\.mjs node/);
});

test("packaging still rebuilds for Electron and restores Node", () => {
  assert.match(pkg.scripts.prepackage, /rebuild-engine-native\.mjs electron/);
  assert.match(pkg.scripts.postpackage, /rebuild-engine-native\.mjs node/);
  assert.match(pkg.scripts["prepackage:dist"], /rebuild-engine-native\.mjs electron/);
  assert.match(pkg.scripts["postpackage:dist"], /rebuild-engine-native\.mjs node/);
});

test("a clean child exit restores the Node ABI and keeps the child status", { timeout: 5000 }, async () => {
  let restores = 0;
  const code = await launchDesktop("dev", {
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    stdio: "ignore",
    restore() {
      restores += 1;
      return 0;
    },
  });
  assert.equal(restores, 1);
  assert.equal(code, 0);
});

test("SIGINT on the child still restores the Node ABI", { timeout: 5000 }, async () => {
  let restores = 0;
  const code = await launchDesktop("preview", {
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    stdio: "ignore",
    restore() {
      restores += 1;
      return 0;
    },
    onChild(child) {
      child.kill("SIGINT");
    },
  });
  assert.equal(restores, 1);
  assert.equal(code, 130);
});

test("a failed restore replaces a successful child status", { timeout: 5000 }, async () => {
  const code = await launchDesktop("dev", {
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    stdio: "ignore",
    restore() {
      return 2;
    },
  });
  assert.equal(code, 2);
});
