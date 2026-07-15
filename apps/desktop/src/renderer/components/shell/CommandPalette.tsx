import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Search } from "lucide-react";
import { clampActiveIndex, filterCommands, nextActiveIndex } from "../../command-palette";

/** One executable palette entry (issue #13). `run` is the existing renderer action — no new IPC. */
export interface Command {
  id: string;
  title: string;
  /** Right-aligned hint (shortcut or category), shown but not matched. */
  hint?: string;
  /** Extra search terms folded into the filter. */
  keywords?: string;
  /** When set, the row is shown but inert; `disabledReason` explains why. */
  disabled?: boolean;
  disabledReason?: string;
  run(): void;
}

interface CommandPaletteProps {
  commands: Command[];
  onClose(): void;
}

const LISTBOX_ID = "command-palette-listbox";
const optionId = (index: number): string => `command-option-${index}`;

/**
 * The ⌘K / Ctrl+K command palette overlay (issue #13). A filter-as-you-type combobox over
 * the shell's existing renderer actions. Full keyboard nav (arrows wrap, Enter runs, Escape
 * closes) plus ARIA combobox/listbox wiring. All keyboard handling lives on the input's
 * onKeyDown and stops propagation, so Escape closes ONLY the palette — it never reaches the
 * document-level Escape listeners in ThreadHistory or the open-chord listener in App.
 */
export function CommandPalette({ commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const results = useMemo(() => filterCommands(commands, query), [commands, query]);

  // Keep the highlighted row valid when the filter narrows the list under it.
  useEffect(() => {
    setActive((a) => clampActiveIndex(a, results.length));
  }, [results.length]);

  // Keep the highlighted row scrolled into view as the arrows move it.
  useEffect(() => {
    document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function choose(cmd: Command | undefined): void {
    if (!cmd || cmd.disabled) return;
    // Close first so focus-moving commands (Focus search / Focus Ask) land after the
    // palette input is gone and can't be stolen back.
    onClose();
    cmd.run();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => nextActiveIndex(a, 1, results.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => nextActiveIndex(a, -1, results.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(results[active]);
    } else if (e.key === "Escape") {
      // Contain Escape to the palette: don't let it bubble to ThreadHistory's document
      // listener (which would close a popover the user didn't mean to touch).
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }

  const activeCmd = results[active];

  return (
    <div
      className="cmdk-backdrop"
      role="presentation"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cmdk-panel" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="cmdk-input-row">
          <Search size={16} />
          {/* eslint-disable-next-line jsx-a11y/no-autofocus -- palette owns focus on open */}
          <input
            className="cmdk-input"
            type="text"
            value={query}
            placeholder="Type a command…"
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls={LISTBOX_ID}
            aria-activedescendant={activeCmd ? optionId(active) : undefined}
            aria-autocomplete="list"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="cmdk-list" id={LISTBOX_ID} role="listbox" aria-label="Commands">
          {results.length === 0 ? (
            <p className="cmdk-empty">No matching commands.</p>
          ) : (
            results.map((cmd, i) => (
              <div
                key={cmd.id}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                aria-disabled={cmd.disabled ? "true" : undefined}
                className={`cmdk-option${i === active ? " active" : ""}${cmd.disabled ? " disabled" : ""}`}
                title={cmd.disabled ? cmd.disabledReason : undefined}
                onPointerMove={() => setActive(i)}
                onClick={() => choose(cmd)}
              >
                <span className="cmdk-option-title">{cmd.title}</span>
                {cmd.disabled && cmd.disabledReason ? (
                  <span className="cmdk-option-reason">{cmd.disabledReason}</span>
                ) : cmd.hint ? (
                  <span className="cmdk-option-hint">{cmd.hint}</span>
                ) : null}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
