// Autosave-before-navigate decision logic (issue #40). Kept pure — no React, no I/O —
// so the "does opening a new doc need to flush the current dirty buffer first?" rule can
// be unit-tested in isolation. App.tsx wires the returned save into the existing
// `source:write` path before it replaces the editor buffer.

/** Minimal structural view of the editor state the decision depends on. */
export interface EditorNavState {
  /** The pane's current node; null when nothing is open. Only `markdown` nodes are editable. */
  activeNode: { path: string; type: string } | null;
  /** The open document key; null when the pane is empty or showing a non-editable host. */
  docKey: string | null;
  /** Current (possibly edited) editor contents. */
  buffer: string;
  /** Last-saved contents; `buffer !== savedContent` means the buffer is dirty. */
  savedContent: string;
}

/** A write the caller must flush to disk before replacing the buffer. */
export interface PendingSave {
  path: string;
  content: string;
}

/**
 * Returns the save that must be flushed to the CURRENT file before navigating away, or
 * null when there is nothing to save. Null cases:
 *   - no editable markdown doc is open (nothing to lose), or
 *   - the buffer is clean (buffer === savedContent).
 *
 * Mirrors the dirty guard in App's `saveBuffer` so autosave-before-navigate and manual
 * save agree on exactly when a write is warranted.
 */
export function pendingSaveBeforeNavigate(state: EditorNavState): PendingSave | null {
  const { activeNode, docKey, buffer, savedContent } = state;
  if (!activeNode || activeNode.type !== "markdown" || !docKey) return null;
  if (buffer === savedContent) return null;
  return { path: activeNode.path, content: buffer };
}
