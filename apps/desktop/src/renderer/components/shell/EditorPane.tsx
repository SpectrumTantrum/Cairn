import { FileText, PanelRight, RefreshCw, X } from "lucide-react";
import type { IndexStats, TreeNode } from "../../../shared/types.js";
import { isAudioPath, isHtmlPath, isImagePath, isPdfPath, isPlainTextPath, isReadOnlyEditorPath, isTablePath, isVideoPath, opensInEditor } from "../../cite-format";
import { MarkdownEditor, type CitationFlash } from "./MarkdownEditor";

export type IndexState = "none" | "indexing" | "indexed" | "stale";

interface EditorPaneProps {
  activeNode: TreeNode | null;
  buffer: string;
  docKey: string | null;
  dirty: boolean;
  loading: boolean;
  loadError: string | null;
  /** Data URL for the in-app image viewer. Null unless an image file is open. */
  imageSrc: string | null;
  /** Data URL for the in-app audio player. Null unless an audio file is open. */
  audioSrc: string | null;
  /** Data URL for the in-app video player. Null unless a video file is open. */
  videoSrc: string | null;
  flash: CitationFlash | null;
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
    imageSrc,
    audioSrc,
    videoSrc,
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
        ) : isPdfPath(activeNode.path) ? (
          <div id="pdf-viewer-host" className="editor-pdf-host" />
        ) : isImagePath(activeNode.path) ? (
          loading ? (
            <div className="editor-empty">
              <p className="muted">Loading {activeNode.name}…</p>
            </div>
          ) : loadError ? (
            <div className="editor-empty">
              <p className="muted">{loadError}</p>
            </div>
          ) : imageSrc ? (
            <div className="editor-image-host">
              <img src={imageSrc} alt={activeNode.name} />
            </div>
          ) : (
            <div className="editor-empty">
              <p className="muted">Loading {activeNode.name}…</p>
            </div>
          )
        ) : isAudioPath(activeNode.path) ? (
          loading ? (
            <div className="editor-empty">
              <p className="muted">Loading {activeNode.name}…</p>
            </div>
          ) : loadError ? (
            <div className="editor-empty">
              <p className="muted">{loadError}</p>
            </div>
          ) : audioSrc ? (
            <div className="editor-audio-host">
              <audio controls src={audioSrc} />
            </div>
          ) : (
            <div className="editor-empty">
              <p className="muted">Loading {activeNode.name}…</p>
            </div>
          )
        ) : isVideoPath(activeNode.path) ? (
          loading ? (
            <div className="editor-empty">
              <p className="muted">Loading {activeNode.name}…</p>
            </div>
          ) : loadError ? (
            <div className="editor-empty">
              <p className="muted">{loadError}</p>
            </div>
          ) : videoSrc ? (
            <div className="editor-video-host">
              <video controls src={videoSrc} />
            </div>
          ) : (
            <div className="editor-empty">
              <p className="muted">Loading {activeNode.name}…</p>
            </div>
          )
        ) : !opensInEditor(activeNode.path) ? (
          <div className="editor-disabled-host">
            <span className="host-type">{hostType(activeNode.name)}</span>
            <h2>{activeNode.name}</h2>
            <p>Markdown, plain text, HTML, CSV, and TSV open in the editor. This format does not.</p>
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
            readOnly={isReadOnlyEditorPath(activeNode.path)}
            onChange={onChange}
            onSave={onSave}
            onCursor={onCursor}
          />
        ) : null}
      </div>

      <StatusBar
        {...props}
        activeIsMarkdown={activeNode?.type === "markdown" && !isReadOnlyEditorPath(activeNode.path)}
        activeIsText={activeNode ? isPlainTextPath(activeNode.path) : false}
        activeIsHtml={activeNode ? isHtmlPath(activeNode.path) : false}
        activeTableLabel={activeNode ? tableLabel(activeNode.path) : null}
        activeIsPdf={activeNode ? isPdfPath(activeNode.path) : false}
        activeIsImage={activeNode ? isImagePath(activeNode.path) : false}
        activeIsAudio={activeNode ? isAudioPath(activeNode.path) : false}
        activeIsVideo={activeNode ? isVideoPath(activeNode.path) : false}
        cursor={cursor}
      />
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
  activeIsText,
  activeIsHtml,
  activeTableLabel,
  activeIsPdf,
  activeIsImage,
  activeIsAudio,
  activeIsVideo,
}: EditorPaneProps & {
  activeIsMarkdown: boolean;
  activeIsText: boolean;
  activeIsHtml: boolean;
  activeTableLabel: string | null;
  activeIsPdf: boolean;
  activeIsImage: boolean;
  activeIsAudio: boolean;
  activeIsVideo: boolean;
}) {
  const showLine = activeIsMarkdown || activeIsText || activeIsHtml || activeTableLabel !== null;
  return (
    <div className="editor-statusbar">
      {showLine ? (
        <>
          <span className="status-item">
            Ln {cursor.line}, Col {cursor.col}
          </span>
          <span className="status-item">
            {activeTableLabel ?? (activeIsHtml ? "HTML" : activeIsText ? "Text" : "Markdown")}
          </span>
        </>
      ) : activeIsPdf ? (
        <span className="status-item">PDF</span>
      ) : activeIsImage ? (
        <span className="status-item">Image</span>
      ) : activeIsAudio ? (
        <span className="status-item">Audio</span>
      ) : activeIsVideo ? (
        <span className="status-item">Video</span>
      ) : null}
      <IndexStatusItem
        indexState={indexState}
        canIndex={canIndex}
        onIndex={onIndex}
      />
      <span className="spacer" />
      <span className="status-item">
        Cairn · {indexStats ? `${indexStats.chunks.toLocaleString()} chunks` : "not indexed"}
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

function tableLabel(path: string): string | null {
  if (!isTablePath(path)) return null;
  return /\.tsv$/i.test(path) ? "TSV" : "CSV";
}

function hostType(name: string): string {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toUpperCase() : "FILE";
  if (["PDF"].includes(ext)) return "PDF";
  if (["MP3", "WAV", "M4A", "MP4", "MOV", "M4V", "WEBM"].includes(ext)) return "AV";
  return ext;
}
