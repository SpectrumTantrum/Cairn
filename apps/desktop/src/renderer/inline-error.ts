/**
 * Electron wraps a rejected IPC invoke as
 * `Error invoking remote method 'chat:send': <message>`.
 * The main process already mapped Ollama-down onto a short sentence; the
 * wrapper is what the chat thread would show inline.
 */
const REMOTE_INVOKE_PREFIX = /^Error invoking remote method '[^']*':\s*/;

export function inlineErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(REMOTE_INVOKE_PREFIX, "");
}
