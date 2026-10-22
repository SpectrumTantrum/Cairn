// Open a .docx in the OS app without letting a stuck opener hold the IPC reply.
// On Linux, Electron 42's shell.openPath promise never settles (the reply is dropped
// at the next GC). Spawn xdg-open and race its exit against our own timer instead.

import { spawn, type ChildProcess } from "node:child_process";

export const DOCX_OPEN_TIMEOUT_MS = 3_000;

export type DocxOpenResult = { ok: true } | { ok: false; message: string };

/** Child surface the opener needs. Tests pass a fake; production uses xdg-open. */
export interface DocxChild {
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): void;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  unref(): void;
}

export interface DocxOpenDeps {
  platform: NodeJS.Platform;
  timeoutMs?: number;
  /** Linux opener. Defaults to a detached `xdg-open`. */
  spawnXdg?: (absPath: string) => DocxChild;
  /** macOS / Windows opener. `shell.openPath` resolves to "" or an error string. */
  openPath?: (absPath: string) => Promise<string>;
  log?: (line: string) => void;
}

export function noAppMessage(fileName: string): string {
  return `No app found to open ${fileName}`;
}

/** xdg-open's documented exit codes that we can explain. Other non-zero codes stay generic. */
export function docxOpenExitMessage(fileName: string, code: number): string {
  if (code === 2) return "File not found";
  if (code === 3 || code === 4) return noAppMessage(fileName);
  return `Could not open ${fileName}`;
}

function defaultSpawnXdg(absPath: string): DocxChild {
  const child: ChildProcess = spawn("xdg-open", [absPath], { detached: true, stdio: "ignore" });
  return child;
}

/**
 * Dispatch an open and always settle within `timeoutMs`.
 * Linux: exit 0, or still running at the timeout, is success (the child is unref'd).
 * ENOENT and a non-zero exit inside the window are errors.
 * Other platforms: a non-empty `openPath` string is an error; a hang is success.
 */
export function dispatchDocxOpen(absPath: string, fileName: string, deps: DocxOpenDeps): Promise<DocxOpenResult> {
  const timeoutMs = deps.timeoutMs ?? DOCX_OPEN_TIMEOUT_MS;
  if (deps.platform === "linux") {
    return raceXdg(absPath, fileName, timeoutMs, deps.spawnXdg ?? defaultSpawnXdg);
  }
  return raceShell(absPath, fileName, timeoutMs, deps.openPath, deps.log ?? ((line) => console.error(line)));
}

function raceXdg(
  absPath: string,
  fileName: string,
  timeoutMs: number,
  spawnXdg: (absPath: string) => DocxChild,
): Promise<DocxOpenResult> {
  return new Promise((resolve) => {
    let settled = false;
    let child: DocxChild | undefined;
    const finish = (result: DocxOpenResult, release: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (release && child) {
        try {
          child.unref();
        } catch {
          // The child is already gone.
        }
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: true }, true), timeoutMs);
    try {
      child = spawnXdg(absPath);
    } catch (error) {
      finish(messageForSpawnError(error, fileName), false);
      return;
    }
    child.on("error", (error) => {
      finish(messageForSpawnError(error, fileName), false);
    });
    child.on("exit", (code) => {
      if (code === 0) {
        finish({ ok: true }, true);
        return;
      }
      if (code === null) {
        finish({ ok: false, message: `Could not open ${fileName}` }, false);
        return;
      }
      finish({ ok: false, message: docxOpenExitMessage(fileName, code) }, false);
    });
  });
}

function messageForSpawnError(error: unknown, fileName: string): DocxOpenResult {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : "";
  if (code === "ENOENT") return { ok: false, message: noAppMessage(fileName) };
  return { ok: false, message: `Could not open ${fileName}` };
}

function raceShell(
  absPath: string,
  fileName: string,
  timeoutMs: number,
  openPath: ((absPath: string) => Promise<string>) | undefined,
  log: (line: string) => void,
): Promise<DocxOpenResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: DocxOpenResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: true }), timeoutMs);
    if (!openPath) {
      finish({ ok: false, message: `Could not open ${fileName}` });
      return;
    }
    // Resolve/reject on a follow-up turn so a sync throw cannot escape, and so a
    // late rejection after the timeout is not an unhandled rejection.
    Promise.resolve()
      .then(() => openPath(absPath))
      .then(
        (failure) => {
          if (typeof failure === "string" && failure.length > 0) {
            log(`[cairn] docx open: ${failure}`);
            finish({ ok: false, message: noAppMessage(fileName) });
            return;
          }
          finish({ ok: true });
        },
        (error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          log(`[cairn] docx open failed: ${detail}`);
          finish({ ok: false, message: `Could not open ${fileName}` });
        },
      );
  });
}
