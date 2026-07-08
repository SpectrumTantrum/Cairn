import { FileText, PanelRight, RefreshCw, X } from "lucide-react";
import type { IndexStats, TreeNode } from "../../../shared/types.js";
import { MarkdownEditor } from "./MarkdownEditor";

export type IndexState = "none" | "indexing" | "indexed" | "stale";

interface EditorPaneProps {
  activeNode: TreeNode | null;
  buffer: string;
  docKey: string | null;
  dirty: boolean;
  loading: boolean;
  loadError: string | null;
  flash: { line: number; nonce: number } | null;
  cursor: { line: number; col: number };
  rightRailOpen: boolean;
  indexState: IndexState;
  indexStats: IndexStats | null;
  canIndex: boolean;
  onChange(value: string): void;
  onSave(): void;
  onCursor(pos: { line: number; col: number }): void;
  onCloseTab(): void;
  onToggleRightRail(): void;
  onIndex(): void;
}

export function EditorPane(props: EditorPaneProps) {
  const {
    activeNode,
    buffer,
    docKey,
    dirty,
    loading,
    loadError,
    flash,
    cursor,
    rightRailOpen,
    onChange,
    onSave,
    onCursor,
    onCloseTab,
    onToggleRightRail,
  } = props;

  return (
    <>
      <div className="editor-tabbar">
        {activeNode ? (
          <>
            <span className="tab-chip">
              {dirty ? <span className="dirty-dot" aria-label="Unsaved changes" /> : null}
              <span className="tab-name">{activeNode.name}</span>
              <button type="button" className="tab-close" title="Close tab" onClick={onCloseTab}>
                <X size={13} />
              </button>
            </span>
            <span className="breadcrumb">{breadcrumb(activeNode.path)}</span>
          </>
        ) : (
          <span className="breadcrumb">No file open</span>
        )}
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className={`icon-btn${rightRailOpen ? " active" : ""}`}
          title={rightRailOpen ? "Hide right rail" : "Show right rail"}
          onClick={onToggleRightRail}
        >
          <PanelRight size={16} />
        </button>
      </div>

      <div className="editor-body">
        {!activeNode ? (
          <div className="editor-empty">
            <FileText size={26} strokeWidth={1.5} />
            <h2>No file open</h2>
            <p>Pick a note from the vault, or click a citation in a grounded answer to jump to its source.</p>
          </div>
        ) : activeNode.type !== "markdown" ? (
          <div className="editor-disabled-host">
            <span className="host-type">{hostType(activeNode.name)}</span>
            <h2>{activeNode.name}</h2>
            <p>
              Only Markdown is indexed, cited, and editable today. Indexing and viewing this format
              needs the multi-format ingestion pipeline (ADR-0009) — a Docling-based parsing sidecar
              that isn't built yet, not just UI click-through wiring.
            </p>
          </div>
        ) : loading ? (
          <div className="editor-empty">
            <p className="muted">Loading {activeNode.name}…</p>
          </div>
        ) : loadError ? (
          <div className="editor-empty">
            <p className="muted">{loadError}</p>
          </div>
        ) : docKey ? (
          <MarkdownEditor
            key={docKey}
            docKey={docKey}
            initialDoc={buffer}
            flash={flash}
            onChange={onChange}
            onSave={onSave}
            onCursor={onCursor}
          />
        ) : null}
      </div>

      <StatusBar {...props} activeIsMarkdown={activeNode?.type === "markdown"} cursor={cursor} />
    </>
  );
}

function StatusBar({
  indexState,
  indexStats,
  canIndex,
  onIndex,
  cursor,
  activeIsMarkdown,
}: EditorPaneProps & { activeIsMarkdown: boolean }) {
  return (
    <div className="editor-statusbar">
      {activeIsMarkdown ? (
        <>
          <span className="status-item">
            Ln {cursor.line}, Col {cursor.col}
          </span>
          <span className="status-item">Markdown</span>
        </>
      ) : null}
      <IndexStatusItem
        indexState={indexState}
        canIndex={canIndex}
        onIndex={onIndex}
      />
      <span className="spacer" />
      <span className="status-item">
        Mneme · {indexStats ? `${indexStats.chunks.toLocaleString()} chunks` : "not indexed"}
      </span>
    </div>
  );
}

function IndexStatusItem({
  indexState,
  canIndex,
  onIndex,
}: {
  indexState: IndexState;
  canIndex: boolean;
  onIndex(): void;
}) {
  if (indexState === "indexing") {
    return (
      <span className="status-item">
        <RefreshCw size={12} /> indexing…
      </span>
    );
  }
  if (indexState === "indexed") {
    return <span className="status-item ok">indexed ✓</span>;
  }
  if (indexState === "stale") {
    return (
      <button type="button" className="status-action warn" onClick={onIndex} disabled={!canIndex}>
        <RefreshCw size={12} /> index stale — reindex
      </button>
    );
  }
  return (
    <button type="button" className="status-action" onClick={onIndex} disabled={!canIndex}>
      not indexed — index vault
    </button>
  );
}

/** "a/b/c.md" → "a › b" (parent folders, filename dropped). */
function breadcrumb(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join(" › ");
}

function hostType(name: string): string {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toUpperCase() : "FILE";
  if (["PDF"].includes(ext)) return "PDF";
  if (["MP3", "WAV", "M4A", "MP4", "MOV", "M4V", "WEBM"].includes(ext)) return "AV";
  return ext;
}
