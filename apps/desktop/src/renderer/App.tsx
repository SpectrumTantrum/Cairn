import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { IndexStats, OllamaStatus, SearchHit, TreeNode } from "../shared/types.js";
import { VaultRail } from "./components/shell/VaultRail";
import { EditorPane } from "./components/shell/EditorPane";
import type { IndexState } from "./components/shell/EditorPane";
import { RightRail } from "./components/shell/RightRail";
import type { RightTab } from "./components/shell/RightRail";
import type { ChatTurn } from "./components/shell/ChatTab";
import { useResizable } from "./components/shell/useResizable";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function vaultName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Append a streamed token to the trailing in-flight assistant turn, if there is one. */
function appendToken(thread: ChatTurn[], token: string): ChatTurn[] {
  const last = thread[thread.length - 1];
  if (!last || last.role !== "assistant" || !last.streaming) return thread;
  const next = thread.slice(0, -1);
  next.push({ role: "assistant", streaming: true, text: last.text + token });
  return next;
}

/** Replace the trailing streaming placeholder with a settled turn (final result or error). */
function settleStreaming(thread: ChatTurn[], settled: ChatTurn): ChatTurn[] {
  const last = thread[thread.length - 1];
  if (!last || last.role !== "assistant" || !last.streaming) return [...thread, settled];
  const next = thread.slice(0, -1);
  next.push(settled);
  return next;
}

function dedupeByFile(sources: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const s of sources) {
    if (seen.has(s.file)) continue;
    seen.add(s.file);
    out.push(s);
  }
  return out;
}

const RIGHT_TAB_KEY = "cairn.rightTab";

export function App() {
  // Vault + tree
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Editor
  const [activeNode, setActiveNode] = useState<TreeNode | null>(null);
  const [docKey, setDocKey] = useState<string | null>(null);
  const [savedContent, setSavedContent] = useState("");
  const [buffer, setBuffer] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [flash, setFlash] = useState<{ line: number; nonce: number } | null>(null);
  const flashNonce = useRef(0);

  // Engine status
  const [indexStats, setIndexStats] = useState<IndexStats | null>(null);
  const [indexState, setIndexState] = useState<IndexState>("none");
  const [ollama, setOllama] = useState<OllamaStatus>({ up: false, models: [] });

  // Right rail
  const [rightTab, setRightTab] = useState<RightTab>(
    () => (window.localStorage.getItem(RIGHT_TAB_KEY) as RightTab | null) ?? "chat",
  );
  const [rightRailOpen, setRightRailOpen] = useState(true);
  const [thread, setThread] = useState<ChatTurn[]>([]);
  const [asking, setAsking] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [lastSources, setLastSources] = useState<SearchHit[]>([]);
  // Vault-relative file paths unchecked in the Sources tab — excluded from the NEXT
  // question's retrieval. Empty = whole index (no scope). Reset on each new answer / thread.
  const [excludedSources, setExcludedSources] = useState<Set<string>>(new Set());

  // Streaming chat request bookkeeping. requestIdRef mints monotonically increasing ids;
  // activeRequestId marks the one whose tokens/result are still wanted (a new send, a
  // thread reset, or a vault switch supersedes any in-flight request).
  const requestIdRef = useRef(0);
  const activeRequestId = useRef(0);

  // Vault search
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);

  const [error, setError] = useState<string | null>(null);

  const vaultRail = useResizable({ storageKey: "cairn.vaultWidth", initial: 246, min: 190, max: 420, edge: "left" });
  const rightRail = useResizable({ storageKey: "cairn.rightWidth", initial: 372, min: 300, max: 560, edge: "right" });

  const dirty = buffer !== savedContent;
  const indexed = indexStats !== null;

  useEffect(() => {
    void refreshOllama();
  }, []);

  useEffect(() => {
    window.localStorage.setItem(RIGHT_TAB_KEY, rightTab);
  }, [rightTab]);

  // Subscribe once to streamed chat tokens. Tokens tagged with a superseded requestId
  // (stale from a re-send / reset) are ignored; live ones append to the streaming turn.
  useEffect(() => {
    const off = window.cairn.onChatToken(({ requestId, token }) => {
      if (requestId !== activeRequestId.current) return;
      setThread((prev) => appendToken(prev, token));
    });
    return off;
  }, []);

  // Sources scope for the NEXT question: the current answer's unique source files, minus
  // any unchecked in the Sources tab. Only becomes an active scope once something is
  // unchecked — otherwise retrieval spans the whole index.
  const dedupedSources = useMemo(() => dedupeByFile(lastSources), [lastSources]);
  const includedFiles = useMemo(
    () => dedupedSources.map((s) => s.file).filter((f) => !excludedSources.has(f)),
    [dedupedSources, excludedSources],
  );
  const scopeActive = excludedSources.size > 0;
  const scopeCount = scopeActive ? includedFiles.length : 0;

  const toggleSource = useCallback((file: string) => {
    setExcludedSources((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  }, []);

  const clearScope = useCallback(() => setExcludedSources(new Set()), []);

  async function refreshOllama(): Promise<void> {
    const status = await window.cairn.checkOllama();
    setOllama(status);
    setSelectedModel((current) => current ?? status.models[0] ?? null);
  }

  async function chooseVault(): Promise<void> {
    setError(null);
    try {
      const selected = await window.cairn.selectVault();
      if (!selected) return;
      setVaultPath(selected);
      setExpanded(new Set());
      setActiveNode(null);
      setDocKey(null);
      setBuffer("");
      setSavedContent("");
      setIndexStats(null);
      setIndexState("none");
      // Invalidate any in-flight chat and drop the server-side thread for the old vault.
      activeRequestId.current = -1;
      setAsking(false);
      setThread([]);
      setLastSources([]);
      setExcludedSources(new Set());
      setSearchOpen(false);
      setSearchQuery("");
      setSearchResults([]);
      void window.cairn.resetChat();
      const nodes = await window.cairn.listTree();
      setTree(nodes);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const toggleFolder = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => setExpanded(new Set()), []);

  /** Load a Markdown node into the editor; optionally flash a cited line afterwards. */
  const openMarkdown = useCallback(async (node: TreeNode, flashLine?: number) => {
    setActiveNode(node);
    setLoading(true);
    setLoadError(null);
    try {
      const content = await window.cairn.readSource(node.path);
      setSavedContent(content);
      setBuffer(content);
      setDocKey(node.path);
      setCursor({ line: 1, col: 1 });
      if (flashLine !== undefined) {
        flashNonce.current += 1;
        setFlash({ line: flashLine, nonce: flashNonce.current });
      }
    } catch (err) {
      setDocKey(null);
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const openNode = useCallback(
    (node: TreeNode) => {
      if (node.type === "markdown") {
        void openMarkdown(node);
      } else {
        // Non-Markdown: generic read-only host, no editor (ADR-0009).
        setActiveNode(node);
        setDocKey(null);
        setLoadError(null);
      }
    },
    [openMarkdown],
  );

  const closeTab = useCallback(() => {
    setActiveNode(null);
    setDocKey(null);
    setBuffer("");
    setSavedContent("");
    setLoadError(null);
  }, []);

  const saveBuffer = useCallback(async () => {
    if (!activeNode || activeNode.type !== "markdown" || !docKey) return;
    if (buffer === savedContent) return;
    try {
      await window.cairn.writeSource(activeNode.path, buffer);
      setSavedContent(buffer);
      // Saved content diverges from the index until a reindex.
      setIndexState((prev) => (prev === "indexed" || prev === "stale" ? "stale" : prev));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [activeNode, docKey, buffer, savedContent]);

  const runIndex = useCallback(async () => {
    if (!vaultPath) return;
    setIndexState("indexing");
    setError(null);
    try {
      const stats = await window.cairn.indexVault({ lexical: !ollama.up });
      setIndexStats(stats);
      setIndexState("indexed");
    } catch (err) {
      setError(errorMessage(err));
      setIndexState(indexStats ? "stale" : "none");
    }
  }, [vaultPath, ollama.up, indexStats]);

  /** Citation click-through: open the cited file in the center pane and flash the line. */
  const openCitation = useCallback(
    (source: SearchHit) => {
      if (!rightRailOpen) setRightRailOpen(true);
      if (docKey === source.file) {
        flashNonce.current += 1;
        setFlash({ line: source.line, nonce: flashNonce.current });
      } else {
        void openMarkdown({ name: basename(source.file), path: source.file, type: "markdown" }, source.line);
      }
    },
    [docKey, openMarkdown, rightRailOpen],
  );

  async function submitChat(): Promise<void> {
    const question = chatInput.trim();
    if (!question || asking) return;

    const requestId = ++requestIdRef.current;
    activeRequestId.current = requestId;
    setThread((prev) => [
      ...prev,
      { role: "user", text: question },
      { role: "assistant", streaming: true, text: "" },
    ]);
    setChatInput("");
    setAsking(true);
    setError(null);

    try {
      const result = await window.cairn.chatSend({
        text: question,
        requestId,
        model: selectedModel ?? undefined,
        scope: scopeActive ? includedFiles : undefined,
      });
      if (activeRequestId.current !== requestId) return; // superseded (reset / new send)
      setThread((prev) => settleStreaming(prev, { role: "assistant", streaming: false, result }));
      if (result.sources.length > 0) {
        setLastSources(result.sources);
      }
      // Checkboxes control the NEXT question's scope, so every settled answer (even an
      // uncovered/refused one with no sources) clears stale exclusions from the prior turn.
      setExcludedSources(new Set());
    } catch (err) {
      if (activeRequestId.current !== requestId) return;
      const message = errorMessage(err);
      setThread((prev) => settleStreaming(prev, { role: "error", text: message }));
    } finally {
      if (activeRequestId.current === requestId) setAsking(false);
    }
  }

  function newThread(): void {
    // Invalidate any in-flight request and drop the server-side thread.
    activeRequestId.current = -1;
    void window.cairn.resetChat();
    setAsking(false);
    setThread([]);
    setLastSources([]);
    setExcludedSources(new Set());
  }

  async function runSearch(): Promise<void> {
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    setError(null);
    try {
      const hits = await window.cairn.searchVault(q);
      setSearchResults(hits);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSearching(false);
    }
  }

  const toggleSearch = useCallback(() => {
    setSearchOpen((open) => {
      if (open) {
        setSearchQuery("");
        setSearchResults([]);
      }
      return !open;
    });
  }, []);

  /** Open a search result in the editor and flash its line (same path as citation pills). */
  const openSearchResult = useCallback(
    (hit: SearchHit) => {
      if (docKey === hit.file) {
        flashNonce.current += 1;
        setFlash({ line: hit.line, nonce: flashNonce.current });
      } else {
        const isMd = hit.file.toLowerCase().endsWith(".md");
        void openMarkdown(
          { name: basename(hit.file), path: hit.file, type: isMd ? "markdown" : "other" },
          hit.line,
        );
      }
    },
    [docKey, openMarkdown],
  );

  const composerReason = useMemo(() => {
    if (!vaultPath) return "Choose a vault to ask grounded questions.";
    if (!indexed) return "Index this vault before asking (status bar, bottom of the editor).";
    if (!ollama.up)
      return "Ask needs local Ollama running with a chat model. No cloud calls are ever made.";
    return null;
  }, [vaultPath, indexed, ollama.up]);

  const composerDisabled = !vaultPath || !indexed || !ollama.up;

  return (
    <div className="shell">
      <div className="pane vault-rail" style={{ width: vaultRail.width }}>
        <VaultRail
          vaultName={vaultPath ? vaultName(vaultPath) : null}
          nodes={tree}
          expanded={expanded}
          activePath={activeNode?.path ?? null}
          searchOpen={searchOpen}
          searchQuery={searchQuery}
          searchResults={searchResults}
          searching={searching}
          canSearch={!!vaultPath && indexed}
          onToggleSearch={toggleSearch}
          onSearchChange={setSearchQuery}
          onSearchSubmit={runSearch}
          onOpenResult={openSearchResult}
          onToggleFolder={toggleFolder}
          onOpenNode={openNode}
          onCollapseAll={collapseAll}
          onSwitchVault={chooseVault}
        />
      </div>

      <div
        className={`resize-handle${vaultRail.dragging ? " dragging" : ""}`}
        onPointerDown={vaultRail.onPointerDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize vault rail"
      />

      <div className="pane editor-pane">
        <EditorPane
          activeNode={activeNode}
          buffer={buffer}
          docKey={docKey}
          dirty={dirty}
          loading={loading}
          loadError={loadError}
          flash={flash}
          cursor={cursor}
          rightRailOpen={rightRailOpen}
          indexState={indexState}
          indexStats={indexStats}
          canIndex={!!vaultPath && indexState !== "indexing"}
          onChange={setBuffer}
          onSave={saveBuffer}
          onCursor={setCursor}
          onCloseTab={closeTab}
          onToggleRightRail={() => setRightRailOpen((v) => !v)}
          onIndex={runIndex}
        />
      </div>

      {rightRailOpen ? (
        <>
          <div
            className={`resize-handle${rightRail.dragging ? " dragging" : ""}`}
            onPointerDown={rightRail.onPointerDown}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize right rail"
          />
          <div className="pane right-rail" style={{ width: rightRail.width }}>
            <RightRail
              activeTab={rightTab}
              onTabChange={setRightTab}
              onNewThread={newThread}
              thread={thread}
              busy={asking}
              input={chatInput}
              composerDisabled={composerDisabled}
              composerReason={composerReason}
              ollamaUp={ollama.up}
              models={ollama.models}
              selectedModel={selectedModel}
              scopeCount={scopeCount}
              onInputChange={setChatInput}
              onSelectModel={setSelectedModel}
              onSubmit={submitChat}
              onClearScope={clearScope}
              onCite={openCitation}
              sources={lastSources}
              excludedSources={excludedSources}
              onToggleSource={toggleSource}
            />
          </div>
        </>
      ) : null}

      {error ? (
        <div className="error-toast" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} title="Dismiss">
            <X size={15} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
