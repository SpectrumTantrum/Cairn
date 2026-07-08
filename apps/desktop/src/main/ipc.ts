import { dialog, ipcMain, shell } from "electron";
import { getModelProvider } from "@cairn/engine";
import { createVaultSession } from "./vault-session.js";

const session = createVaultSession();

const USER_ERROR_PREFIXES = [
  "Choose",
  "Index",
  "No source",
  "No content",
  "Refusing",
  "The requested vault",
  "The selected vault",
  "The source file",
  "Ask needs",
];

function toUserError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (USER_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix))) {
    return new Error(message);
  }
  if (/ollama|fetch failed|ECONNREFUSED|embedder|chat model|\/api\/(embed|chat|tags)|HTTP \d+/i.test(message)) {
    return new Error("Local Ollama request failed. Check that Ollama is running and the required models are installed.");
  }
  if (/sqlite|SQLITE|vec_chunks|better-sqlite3/i.test(message)) {
    return new Error("The local index could not be read. Try re-indexing this vault.");
  }
  return new Error(message.length > 220 ? `${message.slice(0, 217)}...` : message);
}

async function handleUserErrors<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toUserError(error);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Coerce an unknown IPC value into a validated `string[]` scope include-list, or undefined. */
function asScope(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const files = value.filter((x): x is string => typeof x === "string");
  return files.length > 0 ? files : undefined;
}

export function registerIpcHandlers(): void {
  ipcMain.handle("vault:select", async () => {
    return handleUserErrors(async () => {
      const result = await dialog.showOpenDialog({
        title: "Choose Cairn Vault",
        properties: ["openDirectory", "createDirectory"],
      });

      if (result.canceled || !result.filePaths[0]) return null;
      return session.setVault(result.filePaths[0]);
    });
  });

  ipcMain.handle("vault:index", async (_event, opts: unknown) => {
    return handleUserErrors(() => {
      const lexical = typeof opts === "object" && opts !== null && "lexical" in opts
        ? Boolean((opts as { lexical?: unknown }).lexical)
        : false;

      return session.index({ lexical });
    });
  });

  ipcMain.handle("vault:search", async (_event, query: unknown) => {
    return handleUserErrors(() => {
      if (typeof query !== "string") return [];
      return session.search(query);
    });
  });

  ipcMain.handle("vault:ask", async (_event, payload: unknown) => {
    return handleUserErrors(() => {
      const p = asRecord(payload);
      const question = typeof p.question === "string" ? p.question : undefined;
      if (question === undefined) {
        throw new Error("Ask needs a question.");
      }
      const model = typeof p.model === "string" ? p.model : undefined;
      return session.ask(question, { model, scope: asScope(p.scope) });
    });
  });

  // Multi-turn streaming chat. Tokens are forwarded to the requesting renderer via
  // `chat:token` events tagged with the caller's requestId (so the renderer can drop
  // stale tokens from a superseded request); the invoke resolves with the full result.
  ipcMain.handle("chat:send", async (event, payload: unknown) => {
    return handleUserErrors(() => {
      const p = asRecord(payload);
      const text = typeof p.text === "string" ? p.text : "";
      if (!text.trim()) {
        throw new Error("Ask needs a question.");
      }
      const requestId = typeof p.requestId === "number" ? p.requestId : 0;
      const model = typeof p.model === "string" ? p.model : undefined;
      const sender = event.sender;
      return session.chatSend(text, {
        model,
        scope: asScope(p.scope),
        onToken: (token) => {
          if (!sender.isDestroyed()) sender.send("chat:token", { requestId, token });
        },
      });
    });
  });

  ipcMain.handle("chat:reset", async () => {
    return handleUserErrors(() => {
      session.resetChat();
    });
  });

  ipcMain.handle("source:open", async (_event, file: unknown) => {
    return handleUserErrors(async () => {
      if (typeof file !== "string") {
        throw new Error("No source file was provided.");
      }
      const sourcePath = session.resolveSourcePath(file);
      const message = await shell.openPath(sourcePath);
      if (message) throw new Error(message);
    });
  });

  ipcMain.handle("source:read", async (_event, file: unknown) => {
    return handleUserErrors(() => {
      if (typeof file !== "string") {
        throw new Error("No source file was provided.");
      }
      return session.readSource(file);
    });
  });

  ipcMain.handle("source:write", async (_event, payload: unknown) => {
    return handleUserErrors(() => {
      const file = typeof payload === "object" && payload !== null && "file" in payload
        ? (payload as { file?: unknown }).file
        : undefined;
      const content = typeof payload === "object" && payload !== null && "content" in payload
        ? (payload as { content?: unknown }).content
        : undefined;
      if (typeof file !== "string") {
        throw new Error("No source file was provided.");
      }
      if (typeof content !== "string") {
        throw new Error("No content was provided to save.");
      }
      session.writeSource(file, content);
    });
  });

  ipcMain.handle("vault:listTree", async () => {
    return handleUserErrors(() => session.listTree());
  });

  ipcMain.handle("ollama:check", async () => {
    try {
      const provider = getModelProvider();
      const up = await provider.isReachable();
      if (!up) return { up: false, models: [] };
      return { up: true, models: await provider.listModels() };
    } catch {
      return { up: false, models: [] };
    }
  });
}
