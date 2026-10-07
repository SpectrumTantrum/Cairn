// Run electron-vite, then put better-sqlite3 back on the system Node ABI.
//
// predev/prepreview rebuild the shared addon for Electron. npm only runs
// postdev/postpreview when the main script exits on its own; Ctrl-C makes npm
// re-raise SIGINT and skip the post hook (see @npmcli/run-script). Stopping
// `desktop:dev` that way would leave engine tests and the CLI on Electron's
// ABI. This wrapper restores on every exit, including signals. The post hooks
// still call the same restore so a normal exit is covered if Electron is
// launched some other way; the restore script no-ops when Node can already
// load the module.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { constants } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rebuildScript = fileURLToPath(new URL("./rebuild-engine-native.mjs", import.meta.url));

function resolveElectronViteBin() {
  const names = process.platform === "win32" ? ["electron-vite.cmd", "electron-vite"] : ["electron-vite"];
  const roots = [
    new URL("../node_modules/.bin/", import.meta.url),
    new URL("../../../node_modules/.bin/", import.meta.url),
  ];
  for (const root of roots) {
    for (const name of names) {
      const candidate = fileURLToPath(new URL(name, root));
      if (existsSync(candidate)) return candidate;
    }
  }
  return "electron-vite";
}

function signalExitCode(signal) {
  const number = constants.signals[signal];
  return typeof number === "number" ? 128 + number : 1;
}

function restoreNodeAbi() {
  // New process group so a second Ctrl-C does not kill the restore mid-write.
  const result = spawnSync(process.execPath, [rebuildScript, "node"], {
    stdio: "inherit",
    detached: true,
  });
  if (result.error) throw result.error;
  if (result.signal) return signalExitCode(result.signal);
  return result.status ?? 1;
}

/**
 * Spawn the desktop runner and restore the Node ABI when it exits.
 * `command` / `args` default to `electron-vite <mode>`; tests inject a stand-in.
 *
 * @param {"dev" | "preview"} mode
 * @param {{
 *   command?: string,
 *   args?: string[],
 *   stdio?: "inherit" | "ignore" | "pipe",
 *   restore?: () => number,
 *   onChild?: (child: import("node:child_process").ChildProcess) => void,
 * }} [opts]
 * @returns {Promise<number>}
 */
export function launchDesktop(mode, opts = {}) {
  if (mode !== "dev" && mode !== "preview") {
    return Promise.reject(new Error("usage: run-desktop.mjs <dev|preview>"));
  }

  const command = opts.command ?? resolveElectronViteBin();
  const args = opts.args ?? [mode];
  const restore = opts.restore ?? restoreNodeAbi;

  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: opts.stdio ?? "inherit",
      env: process.env,
    });
    let settled = false;

    // Swallow SIGINT/SIGTERM so the wrapper stays up long enough to restore.
    // npm forwards the signal and then exits without postdev/postpreview.
    const forward = (signal) => {
      if (settled || child.exitCode !== null || child.signalCode !== null) return;
      child.kill(signal);
    };
    const onSigint = () => forward("SIGINT");
    const onSigterm = () => forward("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    const removeSignalHandlers = () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };

    const safeRestore = () => {
      try {
        return restore();
      } catch (error) {
        console.error("[cairn] failed to restore better-sqlite3 to the system Node ABI");
        console.error(error);
        return 1;
      }
    };

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      safeRestore();
      removeSignalHandlers();
      reject(error);
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      // Handlers stay installed through the restore so a second Ctrl-C does not
      // kill this process mid-write. `settled` makes them a no-op.
      const restoreStatus = safeRestore();
      removeSignalHandlers();
      const childStatus = signal ? signalExitCode(signal) : (code ?? 0);
      resolvePromise(restoreStatus !== 0 ? restoreStatus : childStatus);
    });

    child.on("spawn", () => {
      opts.onChild?.(child);
    });
  });
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  const mode = process.argv[2];
  if (mode !== "dev" && mode !== "preview") {
    console.error("usage: run-desktop.mjs <dev|preview>");
    process.exit(1);
  }
  launchDesktop(mode).then(
    (code) => {
      process.exit(code);
    },
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
