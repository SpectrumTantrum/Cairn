import { app, dialog, ipcMain, safeStorage, shell } from "electron";
import { join } from "node:path";
import { CloudProvider, getModelProvider, PROVIDER_PRESETS } from "@cairn/engine";
import { createVaultSession } from "./vault-session.js";
import {
  ProviderStore,
  testConnection,
  type ProviderInput,
  type SecretCrypto,
} from "./provider-store.js";

const session = createVaultSession();

// Lazily constructed after app-ready (getPath("userData") needs the app initialized).
let providerStore: ProviderStore | null = null;
function providers(): ProviderStore {
  if (!providerStore) {
    const crypto: SecretCrypto = {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptString(plain),
      decrypt: (cipher) => safeStorage.decryptString(cipher),
    };
    providerStore = new ProviderStore({
      filePath: join(app.getPath("userData"), "cloud-providers.json"),
      crypto,
    });
  }
  return providerStore;
}

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

const PROVIDER_KINDS = new Set(["openai-compat", "anthropic", "azure-openai", "bedrock"]);

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Shallow string→string record, dropping non-string values (untrusted IPC input). */
function strRecord(v: unknown): Record<string, string> | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validate an untrusted provider draft from the renderer into a ProviderInput.
 * Secret fields are read but never logged or echoed; only apiKey / AWS credential
 * strings are accepted, so the renderer cannot smuggle arbitrary structure into the
 * encrypted blob.
 */
function coerceProviderInput(payload: unknown): ProviderInput {
  const p = asRecord(payload);
  const kind = typeof p.kind === "string" && PROVIDER_KINDS.has(p.kind) ? (p.kind as ProviderInput["kind"]) : undefined;
  if (!kind) throw new Error("Refusing to save a provider with an unknown kind.");
  const label = str(p.label);
  if (!label) throw new Error("Give this cloud provider a name.");
  const baseUrl = typeof p.baseUrl === "string" ? p.baseUrl.trim() : "";
  const model = typeof p.model === "string" ? p.model.trim() : "";

  const secretIn = asRecord(p.secret);
  const secret = {
    apiKey: str(secretIn.apiKey),
    accessKeyId: str(secretIn.accessKeyId),
    secretAccessKey: str(secretIn.secretAccessKey),
    sessionToken: str(secretIn.sessionToken),
  };
  const hasSecret = Object.values(secret).some((v) => v !== undefined);

  const maxTokens = typeof p.maxTokens === "number" && Number.isFinite(p.maxTokens) ? p.maxTokens : undefined;

  return {
    id: str(p.id),
    presetId: str(p.presetId),
    label,
    kind,
    baseUrl,
    model,
    authHeader: str(p.authHeader),
    extraHeaders: strRecord(p.extraHeaders),
    extraBody: typeof p.extraBody === "object" && p.extraBody !== null ? (p.extraBody as Record<string, unknown>) : undefined,
    apiVersion: str(p.apiVersion),
    deployment: str(p.deployment),
    region: str(p.region),
    maxTokens,
    secret: hasSecret ? secret : undefined,
  };
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

      // Escalation gate (ADR-0002): an outbound cloud call happens ONLY when the
      // renderer sent an explicit, confirmed `escalate` block naming a CONFIGURED
      // provider. No escalate block ⇒ the turn stays on the local Ollama provider.
      let provider: CloudProvider | undefined;
      let cloudModel: string | undefined;
      const escalate = asRecord(p.escalate);
      const providerId = typeof escalate.providerId === "string" ? escalate.providerId : "";
      if (providerId) {
        if (!providers().has(providerId)) {
          throw new Error("That cloud provider is no longer configured.");
        }
        cloudModel = typeof escalate.model === "string" && escalate.model ? escalate.model : undefined;
        if (!cloudModel) {
          throw new Error("Pick a cloud provider model before escalating.");
        }
        provider = new CloudProvider(providers().resolveConfig(providerId));
      }

      return session.chatSend(text, {
        model: provider ? cloudModel : model,
        scope: asScope(p.scope),
        provider,
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

  // ---- Vault mutations (issue #21) ------------------------------------------
  // create / rename / delete / move — each funnels through VaultSession's shared
  // mutation gate (lexical `../` + `.cairn/` + symlink-escape guards), the same
  // validation `source:write` uses. Delete confirmation is a renderer concern; the
  // main process just enacts the already-validated op. The renderer refreshes the
  // tree via `vault:listTree` afterward.
  ipcMain.handle("vault:createFile", async (_event, payload: unknown) => {
    return handleUserErrors(() => {
      const p = asRecord(payload);
      const path = typeof p.path === "string" ? p.path : undefined;
      if (path === undefined) throw new Error("No source file was provided.");
      session.createFile(path);
    });
  });

  ipcMain.handle("vault:createFolder", async (_event, payload: unknown) => {
    return handleUserErrors(() => {
      const p = asRecord(payload);
      const path = typeof p.path === "string" ? p.path : undefined;
      if (path === undefined) throw new Error("No source file was provided.");
      session.createFolder(path);
    });
  });

  ipcMain.handle("vault:rename", async (_event, payload: unknown) => {
    return handleUserErrors(() => {
      const p = asRecord(payload);
      const from = typeof p.from === "string" ? p.from : undefined;
      const to = typeof p.to === "string" ? p.to : undefined;
      if (from === undefined || to === undefined) throw new Error("No source file was provided.");
      session.rename(from, to);
    });
  });

  ipcMain.handle("vault:move", async (_event, payload: unknown) => {
    return handleUserErrors(() => {
      const p = asRecord(payload);
      const from = typeof p.from === "string" ? p.from : undefined;
      const to = typeof p.to === "string" ? p.to : undefined;
      if (from === undefined || to === undefined) throw new Error("No source file was provided.");
      session.move(from, to);
    });
  });

  ipcMain.handle("vault:delete", async (_event, payload: unknown) => {
    return handleUserErrors(() => {
      const p = asRecord(payload);
      const path = typeof p.path === "string" ? p.path : undefined;
      if (path === undefined) throw new Error("No source file was provided.");
      session.deletePath(path);
    });
  });

  // ---- Agent write-loop (ADR-0008) ------------------------------------------
  // start collects proposals (no writes); apply is the per-hunk approval gate (the
  // only path to disk); revert undoes the whole run byte-identically.
  ipcMain.handle("agent:start", async (_event, payload: unknown) => {
    return handleUserErrors(() => {
      const p = asRecord(payload);
      const goal = typeof p.goal === "string" ? p.goal : "";
      if (!goal.trim()) {
        throw new Error("Agent needs a task to work on.");
      }
      const model = typeof p.model === "string" ? p.model : undefined;
      return session.agentStart(goal, { model, scope: asScope(p.scope) });
    });
  });

  ipcMain.handle("agent:apply", async (_event, payload: unknown) => {
    return handleUserErrors(() => {
      const p = asRecord(payload);
      const runId = typeof p.runId === "string" ? p.runId : "";
      const proposalId = typeof p.proposalId === "string" ? p.proposalId : "";
      if (!runId || !proposalId) {
        throw new Error("Refusing to apply an edit without a run and proposal id.");
      }
      return session.agentApplyHunk(runId, proposalId);
    });
  });

  ipcMain.handle("agent:reject", async (_event, payload: unknown) => {
    return handleUserErrors(() => {
      const p = asRecord(payload);
      const runId = typeof p.runId === "string" ? p.runId : "";
      const proposalId = typeof p.proposalId === "string" ? p.proposalId : "";
      if (!runId || !proposalId) {
        throw new Error("Refusing to resolve an edit without a run and proposal id.");
      }
      return session.agentRejectHunk(runId, proposalId);
    });
  });

  ipcMain.handle("agent:revert", async (_event, payload: unknown) => {
    return handleUserErrors(() => {
      const p = asRecord(payload);
      const runId = typeof p.runId === "string" ? p.runId : "";
      if (!runId) {
        throw new Error("Refusing to revert without a run id.");
      }
      return session.agentRevertRun(runId);
    });
  });

  // ---- BYOK cloud providers (ADR-0002) --------------------------------------
  // Metadata-only list (never returns keys); save/delete; a token-free test probe;
  // and the static preset registry for the settings form. Keys enter via `save` and
  // are injected into transport only inside `chat:send`'s escalation branch above.
  ipcMain.handle("providers:presets", async () => PROVIDER_PRESETS);

  ipcMain.handle("providers:list", async () => {
    return handleUserErrors(() => providers().list());
  });

  ipcMain.handle("providers:save", async (_event, payload: unknown) => {
    return handleUserErrors(() => providers().save(coerceProviderInput(payload)));
  });

  ipcMain.handle("providers:delete", async (_event, id: unknown) => {
    return handleUserErrors(() => {
      if (typeof id !== "string" || !id) throw new Error("That cloud provider is no longer configured.");
      providers().delete(id);
    });
  });

  ipcMain.handle("providers:test", async (_event, payload: unknown) => {
    return handleUserErrors(() => {
      const input = coerceProviderInput(payload);
      return testConnection(providers().configFromInput(input));
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
