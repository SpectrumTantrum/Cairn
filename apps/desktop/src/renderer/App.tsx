import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Cloud, X } from "lucide-react";
import type {
  EscalateTarget,
  IndexStats,
  OllamaStatus,
  ProviderMeta,
  ProviderPreset,
  SearchHit,
  TreeNode,
  TreeSortMode,
} from "../shared/types.js";
import { VaultRail } from "./components/shell/VaultRail";
import { EditorPane } from "./components/shell/EditorPane";
import type { IndexState } from "./components/shell/EditorPane";
import { RightRail } from "./components/shell/RightRail";
import type { RightTab } from "./components/shell/RightRail";
import type { ChatTurn } from "./components/shell/ChatTab";
import type { AgentMode } from "./components/shell/Composer";
import type { UiProposal } from "./components/shell/AgentTurn";
import { SettingsPanel } from "./components/shell/SettingsPanel";
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

/** File-tree sort cycle order; the toggle advances through these in turn. */
const SORT_ORDER: TreeSortMode[] = ["name", "mtime", "size"];
function nextSortMode(mode: TreeSortMode): TreeSortMode {
  return SORT_ORDER[(SORT_ORDER.indexOf(mode) + 1) % SORT_ORDER.length];
}

export function App() {
  // Vault + tree
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [sortMode, setSortMode] = useState<TreeSortMode>("name");
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

  // BYOK cloud escalation (ADR-0002)
  const [providers, setProviders] = useState<ProviderMeta[]>([]);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Armed escalation for the NEXT turn (null = stays local on Ollama).
  const [escalateTarget, setEscalateTarget] = useState<EscalateTarget | null>(null);
  // First-use confirm gate: once a provider is confirmed (or the session-wide skip is
  // set), escalation proceeds without re-prompting. Nothing is ever sent without this.
  const confirmedProviders = useRef<Set<string>>(new Set());
  const [sessionSkipConfirm, setSessionSkipConfirm] = useState(false);
  // Pending escalation awaiting the confirm dialog.
  const [pendingEscalation, setPendingEscalation] = useState<{ question: string; target: EscalateTarget } | null>(null);

  // Right rail
  const [rightTab, setRightTab] = useState<RightTab>(
    () => (window.localStorage.getItem(RIGHT_TAB_KEY) as RightTab | null) ?? "chat",
  );
  const [rightRailOpen, setRightRailOpen] = useState(true);
  const [thread, setThread] = useState<ChatTurn[]>([]);
  const [asking, setAsking] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [mode, setMode] = useState<AgentMode>("ask");
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
    void window.cairn.providerPresets().then(setPresets).catch(() => setPresets([]));
    void refreshProviders();
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

  const refreshProviders = useCallback(async (): Promise<void> => {
    try {
      const list = await window.cairn.listProviders();
      setProviders(list);
      // Disarm escalation if its provider was deleted out from under it.
      setEscalateTarget((cur) => (cur && list.some((p) => p.id === cur.providerId) ? cur : null));
    } catch {
      setProviders([]);
    }
  }, []);

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
      const nodes = await window.cairn.listTree(sortMode);
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

  /** Advance the tree sort mode (name → mtime → size → …) and re-fetch in the new order. */
  const cycleSort = useCallback(async () => {
    if (!vaultPath) return;
    const next = nextSortMode(sortMode);
    setSortMode(next);
    try {
      const nodes = await window.cairn.listTree(next);
      setTree(nodes);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [vaultPath, sortMode]);

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

  function submitChat(): void {
    const question = chatInput.trim();
    if (!question || asking) return;

    // Escalation gate (ADR-0002): the FIRST time a provider is used this session,
    // confirm before any outbound call. Local turns never hit this branch.
    if (escalateTarget) {
      const needsConfirm = !sessionSkipConfirm && !confirmedProviders.current.has(escalateTarget.providerId);
      if (needsConfirm) {
        setPendingEscalation({ question, target: escalateTarget });
        return; // wait for the confirm dialog; input is preserved until we actually send
      }
    }
    void runChat(question, escalateTarget ?? undefined);
  }

  function confirmEscalation(dontAskAgain: boolean): void {
    const pending = pendingEscalation;
    setPendingEscalation(null);
    if (!pending) return;
    if (dontAskAgain) setSessionSkipConfirm(true);
    else confirmedProviders.current.add(pending.target.providerId);
    void runChat(pending.question, pending.target);
  }

  async function runChat(question: string, escalate?: EscalateTarget): Promise<void> {
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
        escalate,
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

  function onSubmit(): void {
    if (mode === "agent") void submitAgent();
    else void submitChat();
  }

  // Agent mode (ADR-0008): start a write run — the loop proposes edits; nothing is
  // written. Each proposal becomes a diff card the user approves or rejects.
  async function submitAgent(): Promise<void> {
    const goal = chatInput.trim();
    if (!goal || asking) return;
    setThread((prev) => [...prev, { role: "user", text: goal }]);
    setChatInput("");
    setAsking(true);
    setError(null);
    try {
      const res = await window.cairn.agentStart({
        goal,
        model: selectedModel ?? undefined,
        scope: scopeActive ? includedFiles : undefined,
      });
      const proposals: UiProposal[] = res.proposals.map((p) => ({ ...p, status: "pending" }));
      setThread((prev) => [
        ...prev,
        {
          role: "agent",
          runId: res.runId,
          answer: res.answer,
          proposals,
          sources: res.sources,
          stopReason: res.stopReason,
          steps: res.steps,
        },
      ]);
      if (res.sources.length > 0) setLastSources(res.sources);
      setExcludedSources(new Set());
    } catch (err) {
      setThread((prev) => [...prev, { role: "error", text: errorMessage(err) }]);
    } finally {
      setAsking(false);
    }
  }

  const patchProposal = useCallback((runId: string, proposalId: string, patch: Partial<UiProposal>) => {
    setThread((prev) =>
      prev.map((t) =>
        t.role === "agent" && t.runId === runId
          ? { ...t, proposals: t.proposals.map((p) => (p.id === proposalId ? { ...p, ...patch } : p)) }
          : t,
      ),
    );
  }, []);

  const onAgentApply = useCallback(
    async (runId: string, proposalId: string) => {
      setError(null);
      try {
        const res = await window.cairn.agentApply(runId, proposalId);
        patchProposal(runId, proposalId, { status: res.status });
        // Refresh the open editor if the agent just wrote the file it has open.
        if (res.status === "applied" && res.content !== undefined && docKey === res.path) {
          setSavedContent(res.content);
          setBuffer(res.content);
        }
        if (res.status === "skipped" && res.reason) setError(res.reason);
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [docKey, patchProposal],
  );

  const onAgentReject = useCallback(
    async (runId: string, proposalId: string) => {
      setError(null);
      try {
        const res = await window.cairn.agentReject(runId, proposalId);
        patchProposal(runId, proposalId, { status: res.status });
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [patchProposal],
  );

  const onAgentRevert = useCallback(
    async (runId: string) => {
      setError(null);
      try {
        await window.cairn.agentRevert(runId);
        setThread((prev) => prev.map((t) => (t.role === "agent" && t.runId === runId ? { ...t, reverted: true } : t)));
        // The vault was restored on disk; rebind the open editor to the reverted content.
        if (activeNode?.type === "markdown" && docKey) {
          try {
            const content = await window.cairn.readSource(docKey);
            setSavedContent(content);
            setBuffer(content);
          } catch {
            // File may have been the target of a reverted create — leave the buffer as-is.
          }
        }
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [activeNode, docKey],
  );

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
          sortMode={sortMode}
          canSort={!!vaultPath}
          onCycleSort={cycleSort}
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
          onOpenSettings={() => setSettingsOpen(true)}
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
              mode={mode}
              composerDisabled={composerDisabled}
              composerReason={composerReason}
              ollamaUp={ollama.up}
              models={ollama.models}
              selectedModel={selectedModel}
              scopeCount={scopeCount}
              providers={providers}
              escalateTarget={escalateTarget}
              onInputChange={setChatInput}
              onSelectMode={setMode}
              onSelectModel={setSelectedModel}
              onSelectEscalation={setEscalateTarget}
              onOpenSettings={() => setSettingsOpen(true)}
              onSubmit={onSubmit}
              onClearScope={clearScope}
              onCite={openCitation}
              onAgentApply={onAgentApply}
              onAgentReject={onAgentReject}
              onAgentRevert={onAgentRevert}
              sources={lastSources}
              excludedSources={excludedSources}
              onToggleSource={toggleSource}
            />
          </div>
        </>
      ) : null}

      {settingsOpen ? (
        <SettingsPanel
          presets={presets}
          providers={providers}
          onClose={() => setSettingsOpen(false)}
          onChanged={() => void refreshProviders()}
        />
      ) : null}

      {pendingEscalation ? (
        <EscalationConfirm
          providerLabel={
            providers.find((p) => p.id === pendingEscalation.target.providerId)?.label ??
            pendingEscalation.target.providerId
          }
          model={pendingEscalation.target.model}
          onCancel={() => setPendingEscalation(null)}
          onConfirm={confirmEscalation}
        />
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

/**
 * First-use escalation confirm (ADR-0002): names the provider + model and exactly what
 * leaves the machine, before a single token is sent. "Don't ask again this session"
 * suppresses re-prompts for the rest of the session only.
 */
function EscalationConfirm({
  providerLabel,
  model,
  onCancel,
  onConfirm,
}: {
  providerLabel: string;
  model: string;
  onCancel(): void;
  onConfirm(dontAskAgain: boolean): void;
}) {
  const [dontAsk, setDontAsk] = useState(false);
  return (
    <div className="settings-backdrop" role="dialog" aria-modal="true" aria-label="Confirm cloud escalation">
      <div className="confirm-dialog">
        <h3>
          <Cloud size={15} /> Send to {providerLabel}?
        </h3>
        <p>
          This sends your question, the retrieved note excerpts used to ground the answer, the grounding
          system prompt, and this thread&apos;s prior turns to <strong>{providerLabel}</strong> (model{" "}
          <code>{model}</code>). You pay per token. Nothing else leaves your machine, and retrieval stays local.
        </p>
        <label className="confirm-check">
          <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
          Don&apos;t ask again this session
        </label>
        <div className="form-actions">
          <span className="spacer" />
          <button type="button" className="ghost-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="primary-btn" onClick={() => onConfirm(dontAsk)}>
            <Cloud size={13} /> Send
          </button>
        </div>
      </div>
    </div>
  );
}
