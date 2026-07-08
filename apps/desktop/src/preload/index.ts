import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { AskResult, ChatSendResult, IndexStats, SearchHit } from "@cairn/engine";
import type { ChatSendPayload, ChatTokenEvent, OllamaStatus, TreeNode } from "../shared/types.js";

export type { AskResult, ChatSendPayload, ChatSendResult, ChatTokenEvent, IndexStats, OllamaStatus, SearchHit, TreeNode };

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
  listTree(): Promise<TreeNode[]>;
  openSource(file: string): Promise<void>;
  readSource(file: string): Promise<string>;
  writeSource(file: string, content: string): Promise<void>;
  checkOllama(): Promise<OllamaStatus>;
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
  listTree: () => ipcRenderer.invoke("vault:listTree"),
  openSource: (file) => ipcRenderer.invoke("source:open", file),
  readSource: (file) => ipcRenderer.invoke("source:read", file),
  writeSource: (file, content) => ipcRenderer.invoke("source:write", { file, content }),
  checkOllama: () => ipcRenderer.invoke("ollama:check"),
};

contextBridge.exposeInMainWorld("cairn", api);

declare global {
  interface Window {
    cairn: CairnApi;
  }
}
