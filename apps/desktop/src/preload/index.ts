import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { AskAgentResult, AskResult, ChatSendResult, IndexStats, ProviderPreset, SearchHit } from "@cairn/engine";
import type {
  AgentApplyResult,
  AgentStartResult,
  ChatSendPayload,
  AskAgentProgressEvent,
  ChatTokenEvent,
  OllamaStatus,
  ProviderInput,
  ProviderMeta,
  StudioTemplateMeta,
  TestConnectionResult,
  ThreadMeta,
  ThreadRecord,
  ThreadSaveInput,
  TreeNode,
  TreeSortMode,
} from "../shared/types.js";

export type {
  AgentApplyResult,
  AgentStartResult,
  AskAgentResult,
  AskResult,
  ChatSendPayload,
  ChatSendResult,
  AskAgentProgressEvent,
  ChatTokenEvent,
  IndexStats,
  OllamaStatus,
  ProviderInput,
  ProviderMeta,
  ProviderPreset,
  StudioTemplateMeta,
  TestConnectionResult,
  ThreadMeta,
  ThreadRecord,
  ThreadSaveInput,
  SearchHit,
  TreeNode,
  TreeSortMode,
};

export interface DesktopFeatures {
  agenticAskEnvDefault: boolean;
}

export interface CairnApi {
  desktopFeatures(): Promise<DesktopFeatures>;
  selectVault(): Promise<string | null>;
  /** Last successfully opened vault, or null to stay on the picker. Never rejects. */
  restoreLastVault(): Promise<string | null>;
  indexVault(opts: { lexical: boolean }): Promise<IndexStats>;
  searchVault(query: string): Promise<SearchHit[]>;
  askVault(question: string, opts?: { model?: string; scope?: string[] }): Promise<AskResult>;
  /** Agentic Ask (read-only tool loop). Used when the agentic Ask feature flag is enabled. */
  askAgentVault(
    question: string,
    opts?: { model?: string; scope?: string[]; retrievalSeed?: boolean; requestId?: number },
  ): Promise<AskAgentResult>;
  /** Subscribe to agentic Ask tool-step progress. Returns an unsubscribe fn. */
  onAskAgentProgress(listener: (event: AskAgentProgressEvent) => void): () => void;
  /** Multi-turn streaming chat. Tokens arrive via `onChatToken`; resolves with the full result. */
  chatSend(payload: ChatSendPayload): Promise<ChatSendResult>;
  /** Reset the active thread (new-thread ⟲). */
  resetChat(): Promise<void>;
  /** Cancel the in-flight Ask without clearing the thread. */
  stopAsk(): Promise<void>;
  /** Subscribe to streamed chat tokens. Returns an unsubscribe fn. */
  onChatToken(listener: (event: ChatTokenEvent) => void): () => void;
  /** List the vault tree; `sort` chooses file order (name / mtime / size), default name. */
  listTree(sort?: TreeSortMode): Promise<TreeNode[]>;
  readSource(file: string): Promise<string>;
  /** Vault image as a data URL for the in-app viewer (png, jpg, jpeg, webp, gif). */
  readImage(file: string): Promise<{ mime: string; dataUrl: string }>;
  /** Vault audio as a data URL for the in-app player (mp3, wav, m4a). */
  readAudio(file: string): Promise<{ mime: string; dataUrl: string }>;
  /** Vault video as a data URL for the in-app player (mp4, webm, mov). */
  readVideo(file: string): Promise<{ mime: string; dataUrl: string }>;
  /** Show a vault PDF in the in-app viewer. `page` is 1-based. Bounds are CSS pixels. */
  openPdf(payload: {
    file: string;
    page?: number;
    bounds: { x: number; y: number; width: number; height: number };
  }): Promise<void>;
  hidePdf(): Promise<void>;
  writeSource(file: string, content: string): Promise<void>;
  // ---- Vault mutations (issue #21) ----
  /** Create a new (empty) file at a vault-relative path. Any extension (ADR-0009). */
  createFile(path: string): Promise<void>;
  /** Create a new folder at a vault-relative path. */
  createFolder(path: string): Promise<void>;
  /** Rename a file/folder in place (new basename, same parent). */
  renamePath(from: string, to: string): Promise<void>;
  /** Move a file/folder to a new vault-relative location. */
  movePath(from: string, to: string): Promise<void>;
  /** Delete a file or folder (folders recursively). Confirmation is a renderer concern. */
  deletePath(path: string): Promise<void>;
  checkOllama(): Promise<OllamaStatus>;
  /**
   * Chat model a fresh profile will send. Both modes prefer qwen3:8b over the
   * first Ollama tag. `agentic` does not change the model. Null when Ollama is
   * down or no chat model is pulled.
   */
  resolveChatModel(agentic: boolean): Promise<string | null>;
  /**
   * Prime the chat model the next Ask will use. `agentic` selects that mode's
   * real prompt prefix. Embedders are ignored. Never rejects.
   */
  warmChatModel(model: string, agentic: boolean): Promise<"warmed" | "skipped" | "failed">;
  /** Agent mode (ADR-0008): start a write run — collects proposals, applies nothing. */
  agentStart(payload: { goal: string; model?: string; scope?: string[] }): Promise<AgentStartResult>;
  /** Approve one proposed edit — the per-hunk gate; the only path to disk. */
  agentApply(runId: string, proposalId: string): Promise<AgentApplyResult>;
  /** Reject one proposed edit — records the decision; no disk change. */
  agentReject(runId: string, proposalId: string): Promise<AgentApplyResult>;
  /** Revert the whole run to its checkpoint, byte-identical. */
  agentRevert(runId: string): Promise<{ reverted: boolean }>;
  // ---- Studio grounded generation (issue #26) ----
  /** The Studio template registry metadata (no prompt scaffolds). */
  studioTemplates(): Promise<StudioTemplateMeta[]>;
  /**
   * Run a Studio template's grounded generation. Returns an AgentStartResult whose single
   * proposal is applied/reverted through the SAME agent:* gate as Agent mode.
   */
  studioGenerate(payload: {
    templateId: string;
    topic: string;
    model?: string;
    scope?: string[];
  }): Promise<AgentStartResult>;
  // ---- BYOK cloud providers (ADR-0002) ----
  /** Static preset registry for the settings form (no secrets). */
  providerPresets(): Promise<ProviderPreset[]>;
  /** Configured providers — metadata only, never key material. */
  listProviders(): Promise<ProviderMeta[]>;
  /** Create/update a provider. The `secret` is stored via safeStorage; never echoed back. */
  saveProvider(input: ProviderInput): Promise<ProviderMeta>;
  deleteProvider(id: string): Promise<void>;
  /** Token-free connection probe (lists models where supported). */
  testProvider(input: ProviderInput): Promise<TestConnectionResult>;
  // ---- Chat thread history (issue #25) ----
  /** Past chat threads, newest-updated first — metadata only, no turn payloads. */
  listThreads(): Promise<ThreadMeta[]>;
  /** Upsert a thread (omit id to create, pass it to update). Returns its metadata. */
  saveThread(input: ThreadSaveInput): Promise<ThreadMeta>;
  /** Full thread with its turns, or null if it no longer exists. */
  loadThread(id: string): Promise<ThreadRecord | null>;
  deleteThread(id: string): Promise<void>;
}

// Allow-list of the only channels the renderer may subscribe to. Keeps the
// event bridge from becoming a generic `ipcRenderer.on` escape hatch.
const SUBSCRIBABLE = new Set(["chat:token", "askAgent:progress"]);

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  if (!SUBSCRIBABLE.has(channel)) {
    throw new Error(`Refusing to subscribe to unknown channel "${channel}".`);
  }
  const wrapped = (_event: IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api: CairnApi = {
  desktopFeatures: () => ipcRenderer.invoke("app:desktopFeatures"),
  selectVault: () => ipcRenderer.invoke("vault:select"),
  restoreLastVault: () => ipcRenderer.invoke("vault:restore"),
  indexVault: (opts) => ipcRenderer.invoke("vault:index", opts),
  searchVault: (query) => ipcRenderer.invoke("vault:search", query),
  askVault: (question, opts) => ipcRenderer.invoke("vault:ask", { question, ...opts }),
  askAgentVault: (question, opts) => ipcRenderer.invoke("vault:askAgent", { question, ...opts }),
  chatSend: (payload) => ipcRenderer.invoke("chat:send", payload),
  resetChat: () => ipcRenderer.invoke("chat:reset"),
  stopAsk: () => ipcRenderer.invoke("chat:stop"),
  onChatToken: (listener) => subscribe<ChatTokenEvent>("chat:token", listener),
  onAskAgentProgress: (listener) => subscribe<AskAgentProgressEvent>("askAgent:progress", listener),
  listTree: (sort) => ipcRenderer.invoke("vault:listTree", sort),
  readSource: (file) => ipcRenderer.invoke("source:read", file),
  readImage: (file) => ipcRenderer.invoke("source:readImage", file),
  readAudio: (file) => ipcRenderer.invoke("source:readAudio", file),
  readVideo: (file) => ipcRenderer.invoke("source:readVideo", file),
  openPdf: (payload) => ipcRenderer.invoke("pdf:open", payload),
  hidePdf: () => ipcRenderer.invoke("pdf:hide"),
  writeSource: (file, content) => ipcRenderer.invoke("source:write", { file, content }),
  createFile: (path) => ipcRenderer.invoke("vault:createFile", { path }),
  createFolder: (path) => ipcRenderer.invoke("vault:createFolder", { path }),
  renamePath: (from, to) => ipcRenderer.invoke("vault:rename", { from, to }),
  movePath: (from, to) => ipcRenderer.invoke("vault:move", { from, to }),
  deletePath: (path) => ipcRenderer.invoke("vault:delete", { path }),
  checkOllama: () => ipcRenderer.invoke("ollama:check"),
  resolveChatModel: (agentic) => ipcRenderer.invoke("ollama:resolveChatModel", agentic),
  warmChatModel: (model, agentic) => ipcRenderer.invoke("ollama:warm", model, agentic),
  agentStart: (payload) => ipcRenderer.invoke("agent:start", payload),
  agentApply: (runId, proposalId) => ipcRenderer.invoke("agent:apply", { runId, proposalId }),
  agentReject: (runId, proposalId) => ipcRenderer.invoke("agent:reject", { runId, proposalId }),
  agentRevert: (runId) => ipcRenderer.invoke("agent:revert", { runId }),
  studioTemplates: () => ipcRenderer.invoke("studio:templates"),
  studioGenerate: (payload) => ipcRenderer.invoke("studio:generate", payload),
  providerPresets: () => ipcRenderer.invoke("providers:presets"),
  listProviders: () => ipcRenderer.invoke("providers:list"),
  saveProvider: (input) => ipcRenderer.invoke("providers:save", input),
  deleteProvider: (id) => ipcRenderer.invoke("providers:delete", id),
  testProvider: (input) => ipcRenderer.invoke("providers:test", input),
  listThreads: () => ipcRenderer.invoke("threads:list"),
  saveThread: (input) => ipcRenderer.invoke("threads:save", input),
  loadThread: (id) => ipcRenderer.invoke("threads:load", id),
  deleteThread: (id) => ipcRenderer.invoke("threads:delete", id),
};

contextBridge.exposeInMainWorld("cairn", api);

declare global {
  interface Window {
    cairn: CairnApi;
  }
}
