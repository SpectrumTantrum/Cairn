// Typed UI-preferences module (issue #24). The single addressable home for the renderer's
// persisted UI preferences, replacing the scattered raw `localStorage` reads/writes that
// lived inline in App.tsx and useResizable. Storage stays in localStorage at alpha scope —
// this module only gives the existing keys one typed, testable surface; it does not move
// where they live. Kept free of DOM/React imports so it can be exercised as a pure module
// under node --test (see test/settings.test.mjs); callers pass `window.localStorage`, which
// structurally satisfies SettingsStore.

/** Minimal subset of the Web Storage API this module needs (window.localStorage fits it). */
export interface SettingsStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Right-rail tab identity (mirrors RightRail's TABS). Re-exported by RightRail. */
export type RightTab = "chat" | "sources" | "studio";
export const RIGHT_TAB_VALUES: readonly RightTab[] = ["chat", "sources", "studio"];
export const DEFAULT_RIGHT_TAB: RightTab = "chat";

/** The localStorage keys this module owns (the previously-scattered set). */
export const SETTINGS_KEYS = {
  rightTab: "cairn.rightTab",
  vaultWidth: "cairn.vaultWidth",
  rightWidth: "cairn.rightWidth",
} as const;

/** A resizable pane's persisted-width contract: key + default + clamp bounds. */
export interface PaneWidthSpec {
  key: string;
  initial: number;
  min: number;
  max: number;
}

export const VAULT_WIDTH: PaneWidthSpec = { key: SETTINGS_KEYS.vaultWidth, initial: 246, min: 190, max: 420 };
export const RIGHT_WIDTH: PaneWidthSpec = { key: SETTINGS_KEYS.rightWidth, initial: 372, min: 300, max: 560 };

function isRightTab(value: string | null): value is RightTab {
  return value !== null && (RIGHT_TAB_VALUES as readonly string[]).includes(value);
}

/** Read the persisted right-rail tab; unknown/corrupt/absent values fall back to the default. */
export function readRightTab(store: SettingsStore): RightTab {
  const raw = store.getItem(SETTINGS_KEYS.rightTab);
  return isRightTab(raw) ? raw : DEFAULT_RIGHT_TAB;
}

export function writeRightTab(store: SettingsStore, tab: RightTab): void {
  store.setItem(SETTINGS_KEYS.rightTab, tab);
}

/** Read a pane width; non-numeric / out-of-range / absent values fall back to `initial`. */
export function readPaneWidth(store: SettingsStore, spec: PaneWidthSpec): number {
  const stored = Number(store.getItem(spec.key));
  return Number.isFinite(stored) && stored >= spec.min && stored <= spec.max ? stored : spec.initial;
}

export function writePaneWidth(store: SettingsStore, spec: PaneWidthSpec, width: number): void {
  store.setItem(spec.key, String(Math.round(width)));
}
