// Shared vault-open checks for Choose vault and relaunch. No Electron, so
// `node --test` can run them. One sentence for every folder we cannot open.

import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

/** Picker sentence for a missing or unreadable vault. `path` is the path we tried. */
export function couldntFindVaultMessage(path: string): string {
  return `Couldn't find your last vault at ${path}. Pick a vault.`;
}

/**
 * A directory we can list, or null. `stat` succeeds on a chmod 000 folder when
 * the parent is searchable, and listing it then throws EACCES. Require R_OK|X_OK
 * so an unreadable folder is the same as a missing one.
 */
export function resolveOpenableVault(input: string): string | null {
  if (input.trim() === "") return null;
  try {
    const vaultPath = realpathSync.native(resolve(input));
    if (!statSync(vaultPath).isDirectory()) return null;
    accessSync(vaultPath, constants.R_OK | constants.X_OK);
    return vaultPath;
  } catch {
    return null;
  }
}

/**
 * One in-flight open per key, then the settled result.
 * The dev window remounts the launch effect (React StrictMode) and would
 * otherwise log and read the index twice. The work callback runs once;
 * it owns the log line. `reset` starts a new event (a later Choose vault).
 */
export function createVaultOpenGate<T>() {
  let flight: Promise<T> | null = null;
  let flightKey: string | null = null;
  let settledKey: string | null = null;
  let settled: T | undefined;
  let hasSettled = false;
  let epoch = 0;

  return {
    run(key: string, work: () => Promise<T>): Promise<T> {
      if (hasSettled && settledKey === key) return Promise.resolve(settled as T);
      if (flight && flightKey === key) return flight;
      const ticket = epoch;
      flightKey = key;
      const pending = Promise.resolve()
        .then(work)
        .then((result) => {
          if (ticket === epoch) {
            settledKey = key;
            settled = result;
            hasSettled = true;
          }
          return result;
        })
        .finally(() => {
          if (flight === pending) {
            flight = null;
            flightKey = null;
          }
        });
      flight = pending;
      return pending;
    },
    reset(): void {
      epoch += 1;
      hasSettled = false;
      settled = undefined;
      settledKey = null;
      flight = null;
      flightKey = null;
    },
  };
}
