// Last-opened vault (main process). The path lives in the app's userData dir, not
// the vault and not renderer localStorage, so a relaunch can reopen it. Electron
// is not imported — the file path is injected — so this module runs under
// `node --test` against a tmp dir.

import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  /** Plain picker sentence when the saved folder is missing. Null otherwise. */
  message: string | null;
}

/** Shown when a saved vault folder is gone. `savedPath` is the path that was stored. */
export function missingLastVaultMessage(savedPath: string): string {
  return `Couldn't find your last vault at ${savedPath}. Pick a vault.`;
}

/**
 * A directory we can list, or null. `stat` succeeds on a chmod 000 folder when
 * the parent is searchable, and `readdir` then throws EACCES. Require R_OK|X_OK
 * so an unreadable folder is the same as a missing one.
 */
function resolveVaultDirectory(input: string): string | null {
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

export class LastVaultStore {
  /**
   * Picker sentence from a clear in this process. Later restores still return
   * it until a vault is remembered or a new store is created.
   */
  private pendingMessage: string | null = null;

  constructor(private readonly filePath: string) {}

  /** Remember a vault that was successfully opened. Replaces any previous entry. */
  remember(vaultPath: string): void {
    const path = resolveVaultDirectory(vaultPath);
    if (!path) {
      throw new Error("The selected vault folder no longer exists.");
    }
    this.pendingMessage = null;
    this.write({ version: 1, path });
  }

  /**
   * Decide whether to reopen the saved vault.
   * A missing or unreadable path, or a corrupt settings file, clears the entry
   * and returns the picker. An absent file stays absent.
   * The missing-folder sentence stays available for later restores in this
   * process (the dev window mounts the restore effect twice) and is gone after
   * a new store, which is the next launch.
   */
  restore(): LastVaultRestore {
    if (!existsSync(this.filePath)) {
      return { path: null, cleared: null, message: this.pendingMessage };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      this.pendingMessage = null;
      this.clear();
      return { path: null, cleared: "corrupt", message: null };
    }
    const saved = readSavedPath(parsed);
    if (saved === null) {
      this.pendingMessage = null;
      this.clear();
      return { path: null, cleared: "corrupt", message: null };
    }
    const path = resolveVaultDirectory(saved);
    if (!path) {
      const message = this.releaseMissing(saved);
      return { path: null, cleared: "unavailable", message };
    }
    if (path !== saved) this.write({ version: 1, path });
    this.pendingMessage = null;
    return { path, cleared: null, message: null };
  }

  /**
   * Drop a saved entry that can no longer be opened and keep the picker
   * sentence for a later restore in this process.
   */
  releaseMissing(savedPath: string): string {
    this.clear();
    const message = missingLastVaultMessage(savedPath);
    this.pendingMessage = message;
    return message;
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
