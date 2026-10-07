// Rebuild the engine's native module (better-sqlite3) for a specific runtime ABI.
//
// Why this exists: @cairn/engine's better-sqlite3 is hoisted into
// packages/engine/node_modules and is SHARED between two consumers that need
// different Node ABIs:
//   - the engine's own `node --test` gates + the `cairn` CLI  -> system Node ABI
//   - Electron (desktop:dev, desktop:preview, and the packaged app) -> Electron ABI
// A single install can only hold one ABI at a time. electron-builder's built-in
// @electron/rebuild proved non-deterministic here (it caches per-ABI in a `bin/`
// dir and silently skips, leaving the app packaged against the wrong ABI), so we
// drive the rebuild explicitly and deterministically via node-gyp/prebuild-install
// env vars instead. sqlite-vec ships a prebuilt loadable extension and is
// ABI-independent, so it is not touched here.
//
// Usage: node scripts/rebuild-engine-native.mjs <electron|node>
//   electron : compile/fetch better-sqlite3 for the installed Electron's ABI
//              (predev, prepreview, prepackage — before Electron loads the module)
//   node     : restore better-sqlite3 to the system Node ABI
//              (postdev, postpreview, postpackage, so engine gates + CLI keep working)
//
// The rebuild is skipped when that runtime can already open an in-memory database.
// postdev/postpreview run even after run-desktop.mjs has restored on Ctrl-C; the
// probe keeps the second call cheap.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const target = process.argv[2];
if (target !== "electron" && target !== "node") {
  console.error("usage: rebuild-engine-native.mjs <electron|node>");
  process.exit(1);
}

const enginePrefix = fileURLToPath(new URL("../../../packages/engine", import.meta.url));
const env = { ...process.env };

const PROBE =
  "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.close();";

function runtimeCanOpenDatabase() {
  try {
    if (target === "node") {
      execFileSync(process.execPath, ["-e", PROBE], {
        cwd: enginePrefix,
        stdio: "ignore",
        timeout: 30_000,
        env: process.env,
      });
      return true;
    }
    const electronBinary = require("electron");
    execFileSync(electronBinary, ["-e", PROBE], {
      cwd: enginePrefix,
      stdio: "ignore",
      timeout: 30_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    return true;
  } catch {
    return false;
  }
}

if (target === "electron") {
  // Read the installed Electron version so the ABI never drifts from the devDep.
  const electronVersion = require("electron/package.json").version;
  if (runtimeCanOpenDatabase()) {
    console.log(
      `[cairn] better-sqlite3 already loads under Electron ${electronVersion} (${process.arch}); skipping rebuild`,
    );
    process.exit(0);
  }
  env.npm_config_runtime = "electron";
  env.npm_config_target = electronVersion;
  env.npm_config_disturl = "https://electronjs.org/headers";
  env.npm_config_arch = process.arch;
  console.log(`[cairn] rebuilding better-sqlite3 for Electron ${electronVersion} (${process.arch})`);
} else {
  if (runtimeCanOpenDatabase()) {
    console.log(
      `[cairn] better-sqlite3 already loads under system Node (${process.versions.node}); skipping rebuild`,
    );
    process.exit(0);
  }
  // Clear any Electron-targeting env so prebuild-install/node-gyp target Node.
  for (const k of ["npm_config_runtime", "npm_config_target", "npm_config_disturl"]) {
    delete env[k];
  }
  console.log(`[cairn] restoring better-sqlite3 to system Node (${process.versions.node})`);
}

execFileSync("npm", ["--prefix", enginePrefix, "rebuild", "better-sqlite3"], {
  stdio: "inherit",
  env,
});
