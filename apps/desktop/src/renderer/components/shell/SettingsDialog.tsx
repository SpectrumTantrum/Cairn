import { useEffect } from "react";
import { Cloud, Settings as SettingsIcon, X } from "lucide-react";
import { RIGHT_TAB_VALUES, type RightTab } from "../../settings";

const RIGHT_TAB_LABELS: Record<RightTab, string> = {
  chat: "Chat",
  sources: "Sources",
  studio: "Studio",
};

interface SettingsDialogProps {
  rightTab: RightTab;
  onRightTabChange(tab: RightTab): void;
  onResetLayout(): void;
  onOpenProviders(): void;
  onClose(): void;
}

/**
 * General app settings (issue #24). The single addressable home for the renderer's
 * persisted UI preferences — right-rail default tab and pane layout — reading and writing
 * through the typed `settings` module rather than scattered raw localStorage. Sectioned so
 * future settings drop in without a redesign.
 *
 * BYOK cloud-provider configuration is a separate, already-built surface (ADR-0002,
 * SettingsPanel.tsx) and is deliberately NOT absorbed here: this panel only points to it.
 */
export function SettingsDialog({
  rightTab,
  onRightTabChange,
  onResetLayout,
  onOpenProviders,
  onClose,
}: SettingsDialogProps) {
  // Escape closes just this panel (matches the shell's other overlays; only one is open
  // at a time). Attached to window so it fires regardless of where focus sits.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="settings-backdrop" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="settings-panel">
        <div className="settings-header">
          <h2>
            <SettingsIcon size={16} /> Settings
          </h2>
          <button type="button" className="icon-btn" title="Close settings" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="settings-body">
          <section className="settings-section">
            <h3 className="settings-section-title">Appearance</h3>
            <label className="field">
              <span>Right-rail default tab</span>
              <select value={rightTab} onChange={(e) => onRightTabChange(e.target.value as RightTab)}>
                {RIGHT_TAB_VALUES.map((t) => (
                  <option key={t} value={t}>
                    {RIGHT_TAB_LABELS[t]}
                  </option>
                ))}
              </select>
            </label>
            <p className="field-note">The tab shown when Cairn reopens; it also tracks your last-used tab.</p>
          </section>

          <section className="settings-section">
            <h3 className="settings-section-title">Layout</h3>
            <div className="settings-row">
              <div className="settings-row-text">
                <span className="settings-row-label">Pane widths</span>
                <span className="settings-row-desc">Reset the vault and chat rails to their default widths.</span>
              </div>
              <button type="button" className="ghost-btn" onClick={onResetLayout}>
                Reset layout
              </button>
            </div>
          </section>

          <section className="settings-section">
            <h3 className="settings-section-title">Cloud models</h3>
            <div className="settings-row">
              <div className="settings-row-text">
                <span className="settings-row-label">Bring your own key (BYOK)</span>
                <span className="settings-row-desc">
                  Configure cloud providers for per-turn escalation. Keys are encrypted on-device (ADR-0002).
                </span>
              </div>
              <button type="button" className="ghost-btn" onClick={onOpenProviders}>
                <Cloud size={13} /> Manage providers…
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
