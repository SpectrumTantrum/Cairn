import { contextBridge, ipcRenderer } from "electron";
import type { AskResult, IndexStats, SearchHit } from "@cairn/engine";
import type { OllamaStatus } from "../shared/types.js";

export type { AskResult, IndexStats, OllamaStatus, SearchHit };

export interface CairnApi {
  selectVault(): Promise<string | null>;
  indexVault(opts: { lexical: boolean }): Promise<IndexStats>;
  searchVault(query: string): Promise<SearchHit[]>;
  askVault(question: string): Promise<AskResult>;
  openSource(file: string): Promise<void>;
  checkOllama(): Promise<OllamaStatus>;
}

const api: CairnApi = {
  selectVault: () => ipcRenderer.invoke("vault:select"),
  indexVault: (opts) => ipcRenderer.invoke("vault:index", opts),
  searchVault: (query) => ipcRenderer.invoke("vault:search", query),
  askVault: (question) => ipcRenderer.invoke("vault:ask", question),
  openSource: (file) => ipcRenderer.invoke("source:open", file),
  checkOllama: () => ipcRenderer.invoke("ollama:check"),
};

contextBridge.exposeInMainWorld("cairn", api);

declare global {
  interface Window {
    cairn: CairnApi;
  }
}
