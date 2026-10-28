// Last-opened vault (main process). The path lives in the app's userData dir, not
// the vault and not renderer localStorage, so a relaunch can reopen it. Electron
// is not imported — the file path is injected — so this module runs under
// `node --test` against a tmp dir.

import type { IndexStats } from "@cairn/engine";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { couldntFindVaultMessage, resolveOpenableVault } from "./vault-open.js";

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

/** What launch tells the renderer. `index` is applied as the indexed state. */
export interface LastVaultLaunch {
  path: string | null;
  message: string | null;
  index: IndexStats | null;
}

export { couldntFindVaultMessage };

export class LastVaultStore {
  /**
   * Picker sentence from a clear in this process. Later restores still return
   * it until a vault is remembered or a new store is created.
   */
  private pendingMessage: string | null = null;

  constructor(private readonly filePath: string) {}

  /** Remember a vault that was successfully opened. Replaces any previous entry. */
  remember(vaultPath: string): void {
    const path = resolveOpenableVault(vaultPath);
    if (!path) {
      throw new Error(couldntFindVaultMessage(resolve(vaultPath)));
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
    const path = resolveOpenableVault(saved);
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
    const message = couldntFindVaultMessage(savedPath);
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

/**
 * One launch decision: reopen, or clear and show the picker.
 * Logs only through `log`, so a caller that runs this once prints one line.
 * `openVault` reads an existing index at most once and returns those stats.
 */
export async function runLastVaultRestore(opts: {
  store: LastVaultStore;
  openVault: (path: string) => Promise<{ path: string; index: IndexStats | null }>;
  log: (line: string) => void;
}): Promise<LastVaultLaunch> {
  try {
    const decision = opts.store.restore();
    if (!decision.path) {
      if (decision.cleared) {
        opts.log(`[cairn] cleared last vault (${decision.cleared}); vault picker`);
      }
      if (decision.message) opts.log(`[cairn] ${decision.message}`);
      return { path: null, message: decision.message, index: null };
    }
    try {
      const opened = await opts.openVault(decision.path);
      opts.log(`[cairn] reopened vault ${opened.path}`);
      return { path: opened.path, message: null, index: opened.index };
    } catch {
      const message = opts.store.releaseMissing(decision.path);
      opts.log("[cairn] cleared last vault (unavailable); vault picker");
      opts.log(`[cairn] ${message}`);
      return { path: null, message, index: null };
    }
  } catch {
    opts.store.clear();
    opts.log("[cairn] cleared last vault (unavailable); vault picker");
    return { path: null, message: null, index: null };
  }
}

function readSavedPath(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const path = (parsed as { path?: unknown }).path;
  return typeof path === "string" ? path : null;
}
