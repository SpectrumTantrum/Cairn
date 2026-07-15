import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { AskResult, ChatSendResult, IndexStats, ProviderPreset, SearchHit } from "@cairn/engine";
import type {
  AgentApplyResult,
  AgentStartResult,
  ChatSendPayload,
  ChatTokenEvent,
  OllamaStatus,
  ProviderInput,
  ProviderMeta,
  TestConnectionResult,
  TreeNode,
  TreeSortMode,
} from "../shared/types.js";

export type {
  AgentApplyResult,
  AgentStartResult,
  AskResult,
  ChatSendPayload,
  ChatSendResult,
  ChatTokenEvent,
  IndexStats,
  OllamaStatus,
  ProviderInput,
  ProviderMeta,
  ProviderPreset,
  TestConnectionResult,
  SearchHit,
  TreeNode,
  TreeSortMode,
};

export interface CairnApi {
  selectVault(): Promise<string | null>;
  indexVault(opts: { lexical: boolean }): Promise<IndexStats>;
  searchVault(query: string): Promise<SearchHit[]>;
  askVault(question: string, opts?: { model?: string; scope?: string[] }): Promise<AskResult>;
  /** Multi-turn streaming chat. Tokens arrive via `onChatToken`; resolves with the full result. */
  chatSend(payload: ChatSendPayload): Promise<ChatSendResult>;
  /** Reset the active thread (new-thread ⟲). */
  resetChat(): Promise<void>;
  /** Subscribe to streamed chat tokens. Returns an unsubscribe fn. */
  onChatToken(listener: (event: ChatTokenEvent) => void): () => void;
  /** List the vault tree; `sort` chooses file order (name / mtime / size), default name. */
  listTree(sort?: TreeSortMode): Promise<TreeNode[]>;
  openSource(file: string): Promise<void>;
  readSource(file: string): Promise<string>;
  writeSource(file: string, content: string): Promise<void>;
  checkOllama(): Promise<OllamaStatus>;
  /** Agent mode (ADR-0008): start a write run — collects proposals, applies nothing. */
  agentStart(payload: { goal: string; model?: string; scope?: string[] }): Promise<AgentStartResult>;
  /** Approve one proposed edit — the per-hunk gate; the only path to disk. */
  agentApply(runId: string, proposalId: string): Promise<AgentApplyResult>;
  /** Reject one proposed edit — records the decision; no disk change. */
  agentReject(runId: string, proposalId: string): Promise<AgentApplyResult>;
  /** Revert the whole run to its checkpoint, byte-identical. */
  agentRevert(runId: string): Promise<{ reverted: boolean }>;
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
}

// Allow-list of the only channels the renderer may subscribe to. Keeps the
// event bridge from becoming a generic `ipcRenderer.on` escape hatch.
const SUBSCRIBABLE = new Set(["chat:token"]);

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  if (!SUBSCRIBABLE.has(channel)) {
    throw new Error(`Refusing to subscribe to unknown channel "${channel}".`);
  }
  const wrapped = (_event: IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api: CairnApi = {
  selectVault: () => ipcRenderer.invoke("vault:select"),
  indexVault: (opts) => ipcRenderer.invoke("vault:index", opts),
  searchVault: (query) => ipcRenderer.invoke("vault:search", query),
  askVault: (question, opts) => ipcRenderer.invoke("vault:ask", { question, ...opts }),
  chatSend: (payload) => ipcRenderer.invoke("chat:send", payload),
  resetChat: () => ipcRenderer.invoke("chat:reset"),
  onChatToken: (listener) => subscribe<ChatTokenEvent>("chat:token", listener),
  listTree: (sort) => ipcRenderer.invoke("vault:listTree", sort),
  openSource: (file) => ipcRenderer.invoke("source:open", file),
  readSource: (file) => ipcRenderer.invoke("source:read", file),
  writeSource: (file, content) => ipcRenderer.invoke("source:write", { file, content }),
  checkOllama: () => ipcRenderer.invoke("ollama:check"),
  agentStart: (payload) => ipcRenderer.invoke("agent:start", payload),
  agentApply: (runId, proposalId) => ipcRenderer.invoke("agent:apply", { runId, proposalId }),
  agentReject: (runId, proposalId) => ipcRenderer.invoke("agent:reject", { runId, proposalId }),
  agentRevert: (runId) => ipcRenderer.invoke("agent:revert", { runId }),
  providerPresets: () => ipcRenderer.invoke("providers:presets"),
  listProviders: () => ipcRenderer.invoke("providers:list"),
  saveProvider: (input) => ipcRenderer.invoke("providers:save", input),
  deleteProvider: (id) => ipcRenderer.invoke("providers:delete", id),
  testProvider: (input) => ipcRenderer.invoke("providers:test", input),
};

contextBridge.exposeInMainWorld("cairn", api);

declare global {
  interface Window {
    cairn: CairnApi;
  }
}
