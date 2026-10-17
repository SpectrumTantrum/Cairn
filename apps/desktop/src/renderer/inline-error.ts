/**
 * Electron wraps a rejected IPC invoke as
 * `Error invoking remote method 'chat:send': Error: <message>`.
 * `ipcMain.handle` serializes the thrown Error with `toString()`, so the
 * class name is part of the message (`Error:`, `TypeError:`, …). The main
 * process already mapped Ollama-down onto a short sentence; both wrappers
 * are what the chat thread would show inline.
 */
const REMOTE_INVOKE_PREFIX = /^Error invoking remote method '[^']*':\s*/;
const SERIALIZED_ERROR_PREFIX = /^(?:[A-Za-z_$][\w$]*)?Error:\s*/;

export function inlineErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(REMOTE_INVOKE_PREFIX, "").replace(SERIALIZED_ERROR_PREFIX, "");
}
