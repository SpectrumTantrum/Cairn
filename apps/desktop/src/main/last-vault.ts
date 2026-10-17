// Last-opened vault (main process). The path lives in the app's userData dir, not
// the vault and not renderer localStorage, so a relaunch can reopen it. Electron
// is not imported — the file path is injected — so this module runs under
// `node --test` against a tmp dir.

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

interface StoreFile {
  version: 1;
  path: string;
}

/** Why a saved entry was removed. `unavailable` covers missing, unreadable, and non-directories. */
export type LastVaultClear = "unavailable" | "corrupt";

export interface LastVaultRestore {
  /** Absolute directory to reopen. Null means show the first-run vault picker. */
  path: string | null;
  /** Set when a saved entry was removed. Null when the file was absent or still valid. */
  cleared: LastVaultClear | null;
}

/** A readable directory, or null. Broken symlinks and permission errors are null. */
function resolveVaultDirectory(input: string): string | null {
  if (input.trim() === "") return null;
  try {
    const vaultPath = realpathSync.native(resolve(input));
    if (!statSync(vaultPath).isDirectory()) return null;
    return vaultPath;
  } catch {
    return null;
  }
}

export class LastVaultStore {
  constructor(private readonly filePath: string) {}

  /** Remember a vault that was successfully opened. Replaces any previous entry. */
  remember(vaultPath: string): void {
    const path = resolveVaultDirectory(vaultPath);
    if (!path) {
      throw new Error("The selected vault folder no longer exists.");
    }
    this.write({ version: 1, path });
  }

  /**
   * Decide whether to reopen the saved vault.
   * A missing or unreadable path, or a corrupt settings file, clears the entry
   * and returns the picker. An absent file stays absent.
   */
  restore(): LastVaultRestore {
    if (!existsSync(this.filePath)) return { path: null, cleared: null };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      this.clear();
      return { path: null, cleared: "corrupt" };
    }
    const saved = readSavedPath(parsed);
    if (saved === null) {
      this.clear();
      return { path: null, cleared: "corrupt" };
    }
    const path = resolveVaultDirectory(saved);
    if (!path) {
      this.clear();
      return { path: null, cleared: "unavailable" };
    }
    if (path !== saved) this.write({ version: 1, path });
    return { path, cleared: null };
  }

  clear(): void {
    try {
      rmSync(this.filePath, { force: true });
    } catch {
      // Best effort. The caller still shows the picker.
    }
  }

  private write(store: StoreFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }
}

function readSavedPath(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const path = (parsed as { path?: unknown }).path;
  return typeof path === "string" ? path : null;
}
