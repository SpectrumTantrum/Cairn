// Rebuild the engine's native module (better-sqlite3) for a specific runtime ABI.
//
// Why this exists: @cairn/engine's better-sqlite3 is hoisted into
// packages/engine/node_modules and is SHARED between two consumers that need
// different Node ABIs:
//   - the engine's own `node --test` gates + the `cairn` CLI  -> system Node ABI
//   - the packaged Electron desktop app                        -> Electron ABI
// A single install can only hold one ABI at a time. electron-builder's built-in
// @electron/rebuild proved non-deterministic here (it caches per-ABI in a `bin/`
// dir and silently skips, leaving the app packaged against the wrong ABI), so we
// drive the rebuild explicitly and deterministically via node-gyp/prebuild-install
// env vars instead. sqlite-vec ships a prebuilt .dylib and is ABI-independent, so
// it is not touched here.
//
// Usage: node scripts/rebuild-engine-native.mjs <electron|node>
//   electron : compile/fetch better-sqlite3 for the installed Electron's ABI
//              (run in prepackage, before electron-builder copies node_modules)
//   node     : restore better-sqlite3 to the system Node ABI
//              (run in postpackage, so engine gates + CLI keep working)

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

if (target === "electron") {
  // Read the installed Electron version so the ABI never drifts from the devDep.
  const electronVersion = require("electron/package.json").version;
  env.npm_config_runtime = "electron";
  env.npm_config_target = electronVersion;
  env.npm_config_disturl = "https://electronjs.org/headers";
  env.npm_config_arch = process.arch;
  console.log(`[cairn] rebuilding better-sqlite3 for Electron ${electronVersion} (${process.arch})`);
} else {
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
