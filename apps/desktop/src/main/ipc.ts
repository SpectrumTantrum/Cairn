import { dialog, ipcMain, shell } from "electron";
import { getModelProvider } from "@cairn/engine";
import { createVaultSession } from "./vault-session.js";

const session = createVaultSession();

const USER_ERROR_PREFIXES = [
  "Choose",
  "Index",
  "No source",
  "Refusing",
  "The requested vault",
  "The selected vault",
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

  ipcMain.handle("vault:ask", async (_event, question: unknown) => {
    return handleUserErrors(() => {
      if (typeof question !== "string") {
        throw new Error("Ask needs a question.");
      }
      return session.ask(question);
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
