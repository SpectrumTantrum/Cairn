import { dialog, ipcMain, shell } from "electron";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { ask, indexVault as runIndexVault, search, Store } from "@cairn/engine";

const OLLAMA = process.env.OLLAMA_HOST || "http://localhost:11434";
let selectedVaultPath: string | null = null;

function normalizeVaultPath(input: unknown): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error("Choose a vault folder first.");
  }
  const vaultPath = resolve(input);
  if (!existsSync(vaultPath) || !statSync(vaultPath).isDirectory()) {
    throw new Error("The selected vault folder no longer exists.");
  }
  return realpathSync.native(vaultPath);
}

function assertSelectedVaultPath(input: unknown): string {
  const vaultPath = normalizeVaultPath(input);
  if (!selectedVaultPath) {
    throw new Error("Choose a vault folder first.");
  }
  if (vaultPath !== selectedVaultPath) {
    throw new Error("The requested vault is not the selected vault.");
  }
  return vaultPath;
}

function assertIndexed(vaultPath: string): void {
  if (!existsSync(join(vaultPath, ".cairn", "index.db"))) {
    throw new Error("Index this vault before searching or asking.");
  }
}

function resolveInsideVault(vaultPath: string, file: unknown): string {
  if (typeof file !== "string" || file.trim() === "") {
    throw new Error("No source file was provided.");
  }
  const target = resolve(vaultPath, file);
  const rel = relative(vaultPath, target);
  if (rel.startsWith("..") || rel === "" || isAbsolute(rel)) {
    throw new Error("Refusing to open a path outside the selected vault.");
  }
  return target;
}

function withStore<T>(vaultPath: string, fn: (store: Store) => Promise<T>): Promise<T> {
  const store = new Store(vaultPath);
  return fn(store).finally(() => {
    store.close();
  });
}

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
      selectedVaultPath = normalizeVaultPath(result.filePaths[0]);
      return selectedVaultPath;
    });
  });

  ipcMain.handle("vault:index", async (_event, path: unknown, opts: unknown) => {
    return handleUserErrors(() => {
      const vaultPath = assertSelectedVaultPath(path);
      const lexical = typeof opts === "object" && opts !== null && "lexical" in opts
        ? Boolean((opts as { lexical?: unknown }).lexical)
        : false;

      return runIndexVault(vaultPath, { lexical });
    });
  });

  ipcMain.handle("vault:search", async (_event, path: unknown, query: unknown) => {
    return handleUserErrors(() => {
      const vaultPath = assertSelectedVaultPath(path);
      assertIndexed(vaultPath);
      if (typeof query !== "string" || query.trim() === "") return [];

      return withStore(vaultPath, async (store) => {
        const result = await search(store, query.trim(), { mode: "auto" });
        return result.hits;
      });
    });
  });

  ipcMain.handle("vault:ask", async (_event, path: unknown, question: unknown) => {
    return handleUserErrors(() => {
      const vaultPath = assertSelectedVaultPath(path);
      assertIndexed(vaultPath);
      if (typeof question !== "string" || question.trim() === "") {
        throw new Error("Ask needs a question.");
      }

      return withStore(vaultPath, (store) => ask(store, question.trim(), { mode: "auto" }));
    });
  });

  ipcMain.handle("source:open", async (_event, path: unknown, file: unknown) => {
    return handleUserErrors(async () => {
      const vaultPath = assertSelectedVaultPath(path);
      const sourcePath = resolveInsideVault(vaultPath, file);
      const message = await shell.openPath(sourcePath);
      if (message) throw new Error(message);
    });
  });

  ipcMain.handle("ollama:check", async () => {
    try {
      const response = await fetch(`${OLLAMA}/api/tags`);
      if (!response.ok) return { up: false, models: [] };
      const body = (await response.json()) as { models?: { name: string }[] };
      return { up: true, models: (body.models ?? []).map((model) => model.name) };
    } catch {
      return { up: false, models: [] };
    }
  });
}
