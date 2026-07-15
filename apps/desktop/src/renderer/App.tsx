import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Cloud, X } from "lucide-react";
import type {
  EscalateTarget,
  IndexStats,
  OllamaStatus,
  ProviderMeta,
  ProviderPreset,
  SearchHit,
  ThreadMeta,
  TreeNode,
  TreeSortMode,
} from "../shared/types.js";
import { pendingSaveBeforeNavigate } from "./editor-nav";
import { VaultRail } from "./components/shell/VaultRail";
import { EditorPane } from "./components/shell/EditorPane";
import type { IndexState } from "./components/shell/EditorPane";
import { RightRail } from "./components/shell/RightRail";
import type { RightTab } from "./components/shell/RightRail";
import type { ChatTurn } from "./components/shell/ChatTab";
import type { AgentMode } from "./components/shell/Composer";
import type { UiProposal } from "./components/shell/AgentTurn";
import { SettingsPanel } from "./components/shell/SettingsPanel";
import { TreeDialogs, type TreeDialog } from "./components/shell/TreeDialogs";
import { CommandPalette, type Command } from "./components/shell/CommandPalette";
import { useResizable } from "./components/shell/useResizable";

/** ⌘K on macOS, Ctrl+K elsewhere — used for the palette hint + open chord (issue #13). */
const IS_MAC = typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac");
const PALETTE_HINT = IS_MAC ? "⌘K" : "Ctrl+K";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

/** Join a folder path ("" = vault root) with a basename into a vault-relative path. */
function joinVaultPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** Parent folder of a vault-relative path ("" when the path is at the root). */
function parentPath(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

/** Default a bare name to `.md` (New note / rename of a Markdown node); keep any existing extension. */
function ensureMdExtension(name: string): string {
  return /\.[^./\\]+$/.test(name) ? name : `${name}.md`;
}

/** Remap a path when `from` (file or folder) was renamed/moved to `to`. null = unaffected. */
function remapPath(p: string, from: string, to: string): string | null {
  if (p === from) return to;
  if (p.startsWith(`${from}/`)) return `${to}${p.slice(from.length)}`;
  return null;
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

/** Derive a thread title from its first user turn (issue #25). Falls back to "New thread". */
function deriveThreadTitle(turns: ChatTurn[]): string {
  const firstUser = turns.find((t) => t.role === "user");
  const text = firstUser && "text" in firstUser ? firstUser.text.trim() : "";
  if (!text) return "New thread";
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
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
  // The open create/rename/move/delete dialog for the vault tree (issue #21).
  const [treeDialog, setTreeDialog] = useState<TreeDialog | null>(null);
  // ⌘K / Ctrl+K command palette overlay (issue #13).
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Set by the "Focus Ask" command; the effect below focuses the composer once the right
  // rail is open and on the chat tab (the textarea only exists then).
  const [pendingAskFocus, setPendingAskFocus] = useState(false);

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
  // Re-entrancy guard for openMarkdown (issue #40): a navigation that may autosave the
  // current buffer is in flight. Rapid double-clicks are dropped until it resolves so we
  // never double-save the dirty file or interleave a save with the buffer swap.
  const navigatingRef = useRef(false);

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
  // Thread history persistence (issue #25). Threads live in userData (main process),
  // not the vault. `activeThreadId` is the persisted thread the visible turns belong to
  // (null until the first turn is saved); the ref mirror keeps the persist effect and
  // async handlers reading a fresh id without re-subscribing.
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const activeThreadIdRef = useRef<string | null>(null);
  // Set before we replace `thread` from a load/reset so the persist effect skips that
  // one render (a freshly-loaded thread must not be re-saved and bumped to the top).
  const suppressPersistRef = useRef(false);
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
    void refreshThreads();
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

  // Persist the thread whenever it settles (issue #25). Guarded so streamed tokens
  // (asking === true) don't write on every delta and a just-loaded thread isn't re-saved.
  // Upsert keeps updating the same `activeThreadId` across turns; the returned id is
  // captured on the first save of a brand-new thread.
  useEffect(() => {
    if (suppressPersistRef.current) {
      suppressPersistRef.current = false;
      return;
    }
    if (asking) return; // mid-stream; wait for the settled turn
    if (thread.length === 0) return; // new-thread reset — nothing to persist
    const id = activeThreadIdRef.current ?? undefined;
    void window.cairn
      .saveThread({ id, title: deriveThreadTitle(thread), turns: thread })
      .then((meta) => {
        activeThreadIdRef.current = meta.id;
        setActiveThreadId(meta.id);
        void refreshThreads();
      })
      .catch(() => {
        // History persistence is best-effort; a failed save never blocks chatting.
      });
  }, [thread, asking]);

  const refreshThreads = useCallback(async (): Promise<void> => {
    try {
      setThreads(await window.cairn.listThreads());
    } catch {
      setThreads([]);
    }
  }, []);

  /** Load a persisted thread into the visible chat (display-only history — see report). */
  const loadThread = useCallback(async (id: string): Promise<void> => {
    try {
      const record = await window.cairn.loadThread(id);
      if (!record) {
        await refreshThreads(); // it was deleted out from under the list
        return;
      }
      // Supersede any in-flight request and drop the engine's server-side context: the
      // loaded turns are prior display history, not a rehydrated engine conversation.
      activeRequestId.current = -1;
      void window.cairn.resetChat();
      setAsking(false);
      suppressPersistRef.current = true;
      setThread(record.turns as ChatTurn[]);
      activeThreadIdRef.current = record.id;
      setActiveThreadId(record.id);
      setLastSources([]);
      setExcludedSources(new Set());
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [refreshThreads]);

  const deleteThread = useCallback(
    async (id: string): Promise<void> => {
      try {
        await window.cairn.deleteThread(id);
        // If the open thread was deleted, drop back to a blank composer.
        if (activeThreadIdRef.current === id) {
          activeRequestId.current = -1;
          void window.cairn.resetChat();
          suppressPersistRef.current = true;
          setThread([]);
          activeThreadIdRef.current = null;
          setActiveThreadId(null);
          setLastSources([]);
          setExcludedSources(new Set());
        }
        await refreshThreads();
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [refreshThreads],
  );

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
      // Detach from any persisted thread; the new vault starts a fresh conversation.
      activeThreadIdRef.current = null;
      setActiveThreadId(null);
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

  /**
   * Load a Markdown node into the editor; optionally flash a cited line afterwards.
   *
   * Every navigation path routes through here (tree clicks, citation pills, search
   * results), so autosave-before-navigate lives here (issue #40): if the current buffer
   * is dirty, flush it to the CURRENT file via the existing `source:write` path BEFORE
   * replacing it. If that save fails we surface the error and stay on the dirty buffer
   * rather than navigate-and-discard. `navigatingRef` drops re-entrant calls so a rapid
   * double-click can't double-save or interleave a save with the buffer swap.
   */
  const openMarkdown = useCallback(async (node: TreeNode, flashLine?: number) => {
    if (navigatingRef.current) return;
    navigatingRef.current = true;
    try {
      const pending = pendingSaveBeforeNavigate({ activeNode, docKey, buffer, savedContent });
      if (pending) {
        try {
          await window.cairn.writeSource(pending.path, pending.content);
          setSavedContent(pending.content);
          // The just-saved file diverges from the index until a reindex.
          setIndexState((prev) => (prev === "indexed" || prev === "stale" ? "stale" : prev));
        } catch (err) {
          // Save failed: do NOT navigate-and-discard. Keep the user on the dirty buffer.
          setError(errorMessage(err));
          return;
        }
      }
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
    } finally {
      navigatingRef.current = false;
    }
  }, [activeNode, docKey, buffer, savedContent]);

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

  // ---- Vault mutations (issue #21) ------------------------------------------
  // The rail buttons + tree context menu open a dialog; the submit handlers below
  // call the mutation IPC, then refresh the tree and rebind the open editor.
  //
  // The tree refresh threads the active sort mode (issue #22) so mutations don't
  // reset the tree back to name order.
  const refreshTree = useCallback(async (): Promise<void> => {
    const nodes = await window.cairn.listTree(sortMode);
    setTree(nodes);
  }, [sortMode]);

  // Open-dialog intents (surfaced by VaultRail buttons + FileTree context menu).
  const onNewFile = useCallback((parent: string) => setTreeDialog({ kind: "newFile", parent }), []);
  const onNewFolder = useCallback((parent: string) => setTreeDialog({ kind: "newFolder", parent }), []);
  const onRenameNode = useCallback((node: TreeNode) => setTreeDialog({ kind: "rename", node }), []);
  const onMoveNode = useCallback((node: TreeNode) => setTreeDialog({ kind: "move", node }), []);
  const onDeleteNode = useCallback((node: TreeNode) => setTreeDialog({ kind: "delete", node }), []);

  // Rebind the open editor / active node / expanded set after a rename or move.
  const remapAfterMove = useCallback((from: string, to: string) => {
    setActiveNode((cur) => {
      if (!cur) return cur;
      const np = remapPath(cur.path, from, to);
      return np ? { ...cur, path: np, name: basename(np) } : cur;
    });
    setDocKey((cur) => (cur ? remapPath(cur, from, to) ?? cur : cur));
    setExpanded((prev) => {
      const next = new Set<string>();
      for (const p of prev) next.add(remapPath(p, from, to) ?? p);
      return next;
    });
  }, []);

  const submitNewFile = useCallback(
    async (parent: string, rawName: string) => {
      const name = ensureMdExtension(rawName.trim());
      if (!name) return;
      const path = joinVaultPath(parent, name);
      setError(null);
      try {
        await window.cairn.createFile(path);
        if (parent) setExpanded((prev) => new Set(prev).add(parent));
        await refreshTree();
        setTreeDialog(null);
        if (name.toLowerCase().endsWith(".md")) void openMarkdown({ name, path, type: "markdown" });
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [refreshTree, openMarkdown],
  );

  const submitNewFolder = useCallback(
    async (parent: string, rawName: string) => {
      const name = rawName.trim();
      if (!name) return;
      const path = joinVaultPath(parent, name);
      setError(null);
      try {
        await window.cairn.createFolder(path);
        setExpanded((prev) => {
          const next = new Set(prev);
          if (parent) next.add(parent);
          return next;
        });
        await refreshTree();
        setTreeDialog(null);
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [refreshTree],
  );

  const submitRename = useCallback(
    async (node: TreeNode, rawName: string) => {
      const trimmed = rawName.trim();
      const name = node.type === "markdown" ? ensureMdExtension(trimmed) : trimmed;
      if (!name || name === node.name) {
        setTreeDialog(null);
        return;
      }
      const to = joinVaultPath(parentPath(node.path), name);
      setError(null);
      try {
        await window.cairn.renamePath(node.path, to);
        await refreshTree();
        setTreeDialog(null);
        remapAfterMove(node.path, to);
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [refreshTree, remapAfterMove],
  );

  const submitMove = useCallback(
    async (node: TreeNode, destFolder: string) => {
      const to = joinVaultPath(destFolder, node.name);
      if (to === node.path) {
        setTreeDialog(null);
        return;
      }
      setError(null);
      try {
        await window.cairn.movePath(node.path, to);
        if (destFolder) setExpanded((prev) => new Set(prev).add(destFolder));
        await refreshTree();
        setTreeDialog(null);
        remapAfterMove(node.path, to);
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [refreshTree, remapAfterMove],
  );

  const submitDelete = useCallback(
    async (node: TreeNode) => {
      setError(null);
      try {
        await window.cairn.deletePath(node.path);
        await refreshTree();
        setTreeDialog(null);
        const affectsOpen = docKey !== null && (docKey === node.path || docKey.startsWith(`${node.path}/`));
        if (affectsOpen) {
          closeTab();
        } else if (activeNode && (activeNode.path === node.path || activeNode.path.startsWith(`${node.path}/`))) {
          setActiveNode(null);
        }
        setExpanded((prev) => {
          const next = new Set<string>();
          for (const p of prev) if (p !== node.path && !p.startsWith(`${node.path}/`)) next.add(p);
          return next;
        });
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [refreshTree, docKey, activeNode, closeTab],
  );

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
    // Detach from the persisted thread so the next turn starts a fresh one (issue #25).
    activeThreadIdRef.current = null;
    setActiveThreadId(null);
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

  // ---- Command palette (issue #13) ------------------------------------------
  // Every command is an EXISTING renderer action — no new IPC. The palette opens on
  // ⌘K/Ctrl+K from anywhere (including inside CodeMirror/the composer) because the chord
  // carries a modifier; plain typing never matches, so it can't steal focus mid-edit.

  /** "Focus search": open the vault search (its input auto-focuses) or re-focus it if already open. */
  const focusSearch = useCallback(() => {
    if (!searchOpen) toggleSearch();
    else document.querySelector<HTMLInputElement>(".vault-search-input")?.focus();
  }, [searchOpen, toggleSearch]);

  /** "Focus Ask": reveal the chat composer and hand it focus (see the effect below for timing). */
  const focusAsk = useCallback(() => {
    setRightRailOpen(true);
    setRightTab("chat");
    setPendingAskFocus(true);
  }, []);

  // Focus the composer textarea once it actually exists (right rail open + chat tab). The
  // textarea is deep in the tree and only mounts under those conditions, so we wait for the
  // committed state rather than focusing synchronously in focusAsk.
  useEffect(() => {
    if (!pendingAskFocus) return;
    if (!rightRailOpen || rightTab !== "chat") return;
    document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus();
    setPendingAskFocus(false);
  }, [pendingAskFocus, rightRailOpen, rightTab]);

  // Global open-chord. Capture phase + stopPropagation so it beats CodeMirror's and the
  // composer's own key handling — the palette opens from anywhere. A blocking modal
  // (vault dialog / settings / escalation confirm) suppresses opening so only one overlay
  // is ever stacked; toggling closed is always allowed.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key !== "k" && e.key !== "K") return;
      if (!paletteOpen && (treeDialog || settingsOpen || pendingEscalation)) return;
      e.preventDefault();
      e.stopPropagation();
      setPaletteOpen((open) => !open);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [paletteOpen, treeDialog, settingsOpen, pendingEscalation]);

  const commands = useMemo<Command[]>(() => {
    const indexReason = !vaultPath
      ? "Choose a vault first"
      : indexState === "indexing"
        ? "Indexing…"
        : undefined;
    const searchReason = !vaultPath
      ? "Choose a vault first"
      : !indexed
        ? "Index this vault first"
        : undefined;
    return [
      {
        id: "choose-vault",
        title: "Choose vault",
        hint: "Vault",
        keywords: "open switch folder select workspace",
        run: () => void chooseVault(),
      },
      {
        id: "index-vault",
        title: "Index vault",
        keywords: "reindex build embed search",
        disabled: !vaultPath || indexState === "indexing",
        disabledReason: indexReason,
        run: () => void runIndex(),
      },
      {
        id: "focus-search",
        title: "Focus search",
        keywords: "find lookup grep vault",
        disabled: !vaultPath || !indexed,
        disabledReason: searchReason,
        run: focusSearch,
      },
      {
        id: "focus-ask",
        title: "Focus Ask",
        keywords: "chat question compose ground",
        disabled: composerDisabled,
        disabledReason: composerReason ?? undefined,
        run: focusAsk,
      },
      {
        id: "toggle-right-rail",
        title: "Toggle right rail",
        keywords: "chat sources studio panel hide show",
        run: () => setRightRailOpen((v) => !v),
      },
    ];
  }, [vaultPath, indexed, indexState, composerDisabled, composerReason, runIndex, focusSearch, focusAsk]);

  return (
    <div className="shell">
      <div className="pane vault-rail" style={{ width: vaultRail.width }}>
        <VaultRail
          vaultName={vaultPath ? vaultName(vaultPath) : null}
          paletteHint={PALETTE_HINT}
          onOpenPalette={() => setPaletteOpen(true)}
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
          canMutate={!!vaultPath}
          onNewFile={onNewFile}
          onNewFolder={onNewFolder}
          onRenameNode={onRenameNode}
          onMoveNode={onMoveNode}
          onDeleteNode={onDeleteNode}
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
              threads={threads}
              activeThreadId={activeThreadId}
              onOpenHistory={() => void refreshThreads()}
              onLoadThread={(id) => void loadThread(id)}
              onDeleteThread={(id) => void deleteThread(id)}
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

      {treeDialog ? (
        <TreeDialogs
          dialog={treeDialog}
          tree={tree}
          onCancel={() => setTreeDialog(null)}
          onCreateFile={submitNewFile}
          onCreateFolder={submitNewFolder}
          onRename={submitRename}
          onMove={submitMove}
          onDelete={submitDelete}
        />
      ) : null}

      {paletteOpen ? (
        <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />
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
