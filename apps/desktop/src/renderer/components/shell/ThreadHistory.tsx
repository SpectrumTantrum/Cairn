import { useEffect, useRef, useState } from "react";
import { MessageSquarePlus, Trash2 } from "lucide-react";
import type { ThreadMeta } from "../../../shared/types.js";

interface ThreadHistoryProps {
  threads: ThreadMeta[];
  activeThreadId: string | null;
  onLoad(id: string): void;
  onDelete(id: string): void;
  onNewThread(): void;
  onClose(): void;
}

/**
 * Thread-history popover for the RightRail "⋯" button (issue #25). A simple list of
 * past conversations — load one, start a new one, or delete with an inline confirm.
 * No search/filter (out of scope). Closes on outside click or Escape.
 */
export function ThreadHistory({
  threads,
  activeThreadId,
  onLoad,
  onDelete,
  onNewThread,
  onClose,
}: ThreadHistoryProps) {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocPointer(e: PointerEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("pointerdown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div className="thread-history" ref={ref} role="menu" aria-label="Thread history">
      <button type="button" className="thread-history-new" onClick={onNewThread} role="menuitem">
        <MessageSquarePlus size={14} /> New thread
      </button>
      <div className="thread-history-list">
        {threads.length === 0 ? (
          <p className="thread-history-empty">No saved threads yet.</p>
        ) : (
          threads.map((t) => (
            <div
              key={t.id}
              className={`thread-history-row${t.id === activeThreadId ? " active" : ""}`}
            >
              <button
                type="button"
                className="thread-history-open"
                title={t.title}
                onClick={() => onLoad(t.id)}
                role="menuitem"
              >
                <span className="thread-history-title">{t.title}</span>
                <span className="thread-history-meta">{formatWhen(t.updatedAt)}</span>
              </button>
              {confirmDelete === t.id ? (
                <span className="thread-history-confirm">
                  <button
                    type="button"
                    className="thread-history-confirm-yes"
                    onClick={() => {
                      setConfirmDelete(null);
                      onDelete(t.id);
                    }}
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    className="thread-history-confirm-no"
                    onClick={() => setConfirmDelete(null)}
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="thread-history-delete"
                  title="Delete thread"
                  aria-label={`Delete thread "${t.title}"`}
                  onClick={() => setConfirmDelete(t.id)}
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** Compact relative-ish timestamp for the history list. */
function formatWhen(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ms).toLocaleDateString();
}
