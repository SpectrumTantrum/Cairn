// Map main-process failures onto short messages safe to show in the renderer.
// Kept out of ipc.ts so the classification can be tested without Electron.

const USER_ERROR_PREFIXES = [
  "Choose",
  "Index",
  "No source",
  "No content",
  "Refusing",
  "Cloud",
  "Secure key storage",
  "Stored API key",
  "That cloud provider",
  "Pick a cloud provider",
  "The requested vault",
  "The selected vault",
  "The source file",
  "Ask needs",
  "Agent needs",
  "Agent mode needs",
  "This agent run",
  "That proposed edit",
  "Revert is unsafe",
  "Studio needs",
  "The requested Studio",
  "Unknown Studio template",
];

// Deliberately-surfaced user messages whose safe text is NOT at the start — a value is
// interpolated as the prefix (e.g. a Studio template title). Matched by regex so they are
// allow-listed by intent, not merely returned by the generic fallback branch below.
const USER_ERROR_PATTERNS = [
  // studio-generate.ts: `The "<title>" generator is not available yet.`
  /^The ".+" generator is not available yet\.$/,
];

/** Shown when Node's loader rejects better-sqlite3 (wrong NODE_MODULE_VERSION, bad ELF, …). */
export const NATIVE_MODULE_MISMATCH_MESSAGE =
  "Cairn's database module does not match this app's runtime. Quit, then start again with npm run desktop:dev so the native module rebuilds for Electron.";

/** Shown for a real SQLite/index failure (corrupt db, missing table), where re-indexing can help. */
export const INDEX_READ_MESSAGE = "The local index could not be read. Try re-indexing this vault.";

const OLLAMA_MESSAGE =
  "Local Ollama request failed. Check that Ollama is running and the required models are installed.";

// Node's dlopen error names the .node file (often under better-sqlite3/) AND the ABI
// (`NODE_MODULE_VERSION 127` vs Electron `146`). That string also matches the generic
// sqlite/better-sqlite3 filter, so ABI must be classified first — re-indexing cannot
// fix a native module built for the wrong runtime.
const NATIVE_MODULE_MISMATCH_RE =
  /NODE_MODULE_VERSION|compiled against a different Node\.js version|did not self-register|invalid ELF header|ERR_DLOPEN_FAILED/i;

const INDEX_READ_RE = /sqlite|SQLITE|vec_chunks|better-sqlite3/i;

const OLLAMA_RE = /ollama|fetch failed|ECONNREFUSED|embedder|chat model|\/api\/(embed|chat|tags)|HTTP \d+/i;

function errorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) return "";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? error.cause.message : "";
    return cause ? `${error.message}\n${cause}` : error.message;
  }
  return String(error);
}

function isNativeModuleMismatch(error: unknown, message: string): boolean {
  const code = errorCode(error);
  const causeCode = error instanceof Error ? errorCode(error.cause) : "";
  return (
    code === "ERR_DLOPEN_FAILED" ||
    causeCode === "ERR_DLOPEN_FAILED" ||
    NATIVE_MODULE_MISMATCH_RE.test(message) ||
    NATIVE_MODULE_MISMATCH_RE.test(code) ||
    NATIVE_MODULE_MISMATCH_RE.test(causeCode)
  );
}

export function toUserError(error: unknown): Error {
  const message = errorMessage(error);
  if (
    USER_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix)) ||
    USER_ERROR_PATTERNS.some((re) => re.test(message))
  ) {
    return new Error(message);
  }
  if (OLLAMA_RE.test(message)) {
    return new Error(OLLAMA_MESSAGE);
  }
  if (isNativeModuleMismatch(error, message)) {
    return new Error(NATIVE_MODULE_MISMATCH_MESSAGE);
  }
  if (INDEX_READ_RE.test(message)) {
    return new Error(INDEX_READ_MESSAGE);
  }
  return new Error(message.length > 220 ? `${message.slice(0, 217)}...` : message);
}
