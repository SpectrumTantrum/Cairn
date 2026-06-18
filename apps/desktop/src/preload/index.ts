import { contextBridge, ipcRenderer } from "electron";

export interface IndexStats {
  mode: "hybrid" | "lexical";
  files: number;
  chunks: number;
  embedded: number;
  cached: number;
  embedder?: string;
  dim?: number;
}

export interface SearchHit {
  file: string;
  heading: string;
  line: number;
  score: number | null;
  cosine: number | null;
  snippet: string;
  text: string;
  arms: string;
}

export interface AskResult {
  answer: string;
  sources: SearchHit[];
  mode: "hybrid" | "lexical";
  grounded: boolean;
  covered: boolean;
  model?: string;
  reason?: string;
}

export interface OllamaStatus {
  up: boolean;
  models: string[];
}

export interface CairnApi {
  selectVault(): Promise<string | null>;
  indexVault(path: string, opts: { lexical: boolean }): Promise<IndexStats>;
  searchVault(path: string, query: string): Promise<SearchHit[]>;
  askVault(path: string, question: string): Promise<AskResult>;
  openSource(path: string, file: string, line: number): Promise<void>;
  checkOllama(): Promise<OllamaStatus>;
}

const api: CairnApi = {
  selectVault: () => ipcRenderer.invoke("vault:select"),
  indexVault: (path, opts) => ipcRenderer.invoke("vault:index", path, opts),
  searchVault: (path, query) => ipcRenderer.invoke("vault:search", path, query),
  askVault: (path, question) => ipcRenderer.invoke("vault:ask", path, question),
  openSource: (path, file, line) => ipcRenderer.invoke("source:open", path, file, line),
  checkOllama: () => ipcRenderer.invoke("ollama:check"),
};

contextBridge.exposeInMainWorld("cairn", api);

declare global {
  interface Window {
    cairn: CairnApi;
  }
}
