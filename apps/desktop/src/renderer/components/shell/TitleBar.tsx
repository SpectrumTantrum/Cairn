import { Minus, Square, Copy, X } from "lucide-react";
import type { WindowChromeKind } from "../../../shared/window-chrome.js";

interface TitleBarProps {
  kind: WindowChromeKind;
  maximized: boolean;
  onMinimize(): void;
  onToggleMaximize(): void;
  onClose(): void;
}

/**
 * Themed window chrome that replaces Electron's default File/Edit/View/Window bar.
 * Drag region for moving the window; caption buttons only when we drew the frame
 * ourselves (`custom`). Overlay / traffic-lights leave OS buttons in place.
 */
export function TitleBar({
  kind,
  maximized,
  onMinimize,
  onToggleMaximize,
  onClose,
}: TitleBarProps) {
  return (
    <div
      className={`titlebar titlebar-${kind}`}
      onDoubleClick={onToggleMaximize}
    >
      <span className="titlebar-title">Cairn</span>
      {kind === "custom" ? (
        <div className="titlebar-controls" onDoubleClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="titlebar-btn"
            title="Minimize"
            aria-label="Minimize"
            onClick={onMinimize}
          >
            <Minus size={12} />
          </button>
          <button
            type="button"
            className="titlebar-btn"
            title={maximized ? "Restore" : "Maximize"}
            aria-label={maximized ? "Restore" : "Maximize"}
            onClick={onToggleMaximize}
          >
            {maximized ? <Copy size={11} /> : <Square size={11} />}
          </button>
          <button
            type="button"
            className="titlebar-btn titlebar-btn-close"
            title="Close"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={13} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
