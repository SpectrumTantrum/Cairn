// The root workspace lockfile must list every platform build of optional
// native packages (sqlite-vec, rollup, esbuild), not only the OS that last
// wrote it. npm omits the other platforms when a lockfile is regenerated
// with node_modules already present (https://github.com/npm/cli/issues/4828).
// `npm ci` then installs nothing for the missing OS, and Linux fails with
// "Cannot find package 'sqlite-vec-linux-x64'" / a missing Rollup native.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const lockPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package-lock.json");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const packages = lock.packages ?? {};
const missing = [];

for (const [parentKey, meta] of Object.entries(packages)) {
  const optional = meta.optionalDependencies;
  if (!optional) continue;
  for (const [name, version] of Object.entries(optional)) {
    // Ranges such as fsevents' "~2.3.2" are not per-platform tarballs.
    if (/[~^*><=|]|\s/.test(version)) continue;
    const found = Object.entries(packages).some(([key, pkg]) => {
      if (pkg.version !== version) return false;
      return key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`);
    });
    if (!found) {
      missing.push(`${name}@${version} (from ${parentKey || "root"})`);
    }
  }
}

if (missing.length > 0) {
  console.error(
    `package-lock.json is missing ${missing.length} exact optional dependencies:`,
  );
  for (const line of missing) console.error(`  - ${line}`);
  console.error(
    "Regenerate from an empty tree (remove node_modules and package-lock.json, then npm install) so every platform package is recorded.",
  );
  process.exit(1);
}

console.log("package-lock.json includes every exact optional dependency");
