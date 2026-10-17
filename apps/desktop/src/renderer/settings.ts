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
  /** When true, Ask/Chat uses the agentic read-only tool loop instead of classic grounded chat. */
  agenticAsk: "cairn.agenticAsk",
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

function parseBool(raw: string | null): boolean | null {
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return null;
}

/** Persisted UI toggle for agentic Ask (default off). */
export function readAgenticAskPref(store: SettingsStore): boolean {
  return parseBool(store.getItem(SETTINGS_KEYS.agenticAsk)) === true;
}

export function writeAgenticAskPref(store: SettingsStore, enabled: boolean): void {
  store.setItem(SETTINGS_KEYS.agenticAsk, enabled ? "1" : "0");
}

/**
 * Effective agentic Ask routing: env default (`CAIRN_AGENTIC_ASK=1`) OR the settings toggle.
 * Env does not disable an explicit user preference when env is unset.
 */
export function isAgenticAskEnabled(store: SettingsStore, envDefault = false): boolean {
  const pref = parseBool(store.getItem(SETTINGS_KEYS.agenticAsk));
  if (pref !== null) return pref;
  return envDefault;
}

/**
 * Default chat-model order in `resolveChatModel` (`packages/engine/src/chat.ts`).
 * Guidance uses the same order when the chip is unset or names an embedder.
 */
const CHAT_MODEL_PREFER = ["qwen3:8b", "qwen3:4b", "qwen3", "llama3.2:3b", "llama3.2"] as const;

/** Agentic Ask is tested on this tag. `:latest` is the same model. */
export const TESTED_AGENTIC_MODEL = "qwen3:8b";

export const TESTED_AGENTIC_LINE = "Tested with qwen3:8b.";

export const AGENTIC_TOOLS_WARNING =
  "This model can't use tools, so Agentic Ask won't work with it. Pick qwen3:8b or turn Agentic Ask off.";

/** `/api/show` tool capability. `unknown` is a missing field, a failure, or Ollama down. */
export type ModelToolCapability = "capable" | "incapable" | "unknown";

export interface AgenticGuidance {
  /** Always present under the Agentic Ask toggle. */
  settingsLine: string;
  /** Plain warning in Settings. Null when there is nothing to warn about. */
  settingsWarning: string | null;
  /** The same warning above the composer. Null for the tested and untested-but-capable cases. */
  composerWarning: string | null;
}

/** Embedders are not chat models (`resolveChatModel` skips `/embed/i` the same way). */
export function isEmbedderName(name: string): boolean {
  return /embed/i.test(name);
}

/** `qwen3:8b` and `qwen3:8b:latest` are the tested tag. Other names are not. */
export function isTestedAgenticModel(model: string): boolean {
  return model.replace(/:latest$/i, "") === TESTED_AGENTIC_MODEL;
}

/**
 * The chat model the next Ask will use: the chip when it names a chat model,
 * otherwise `resolveChatModel` with no explicit request. An embedder chip does
 * not count and falls through to that default.
 */
export function resolveAskChatModel(selected: string | null, models: readonly string[]): string | null {
  const requested = selected && !isEmbedderName(selected) ? selected : undefined;
  if (requested) {
    if (models.includes(requested)) return requested;
    const family = models.find((name) => name.split(":")[0] === requested.split(":")[0]);
    return family ?? requested;
  }
  for (const prefer of CHAT_MODEL_PREFER) {
    if (models.includes(prefer)) return prefer;
  }
  for (const prefer of CHAT_MODEL_PREFER) {
    const family = models.find((name) => name.split(":")[0] === prefer.split(":")[0] && !isEmbedderName(name));
    if (family) return family;
  }
  return models.find((name) => !isEmbedderName(name)) ?? null;
}

/**
 * Settings copy and the composer warning for Agentic Ask.
 * Capable + tested model names the model. Capable + anything else says it is untested
 * (Settings only). No `tools` capability warns in Settings and above the composer.
 * Unknown, Ollama down, and agentic off keep the tested line and show no warning.
 */
export function agenticGuidanceText(input: {
  agentic: boolean;
  ollamaUp: boolean;
  model: string | null;
  capability: ModelToolCapability;
}): AgenticGuidance {
  const quiet: AgenticGuidance = {
    settingsLine: TESTED_AGENTIC_LINE,
    settingsWarning: null,
    composerWarning: null,
  };
  if (!input.agentic || !input.ollamaUp || !input.model || input.capability === "unknown") return quiet;
  if (input.capability === "incapable") {
    return {
      settingsLine: TESTED_AGENTIC_LINE,
      settingsWarning: AGENTIC_TOOLS_WARNING,
      composerWarning: AGENTIC_TOOLS_WARNING,
    };
  }
  if (isTestedAgenticModel(input.model)) {
    return {
      settingsLine: `${TESTED_AGENTIC_LINE} Using ${input.model}.`,
      settingsWarning: null,
      composerWarning: null,
    };
  }
  return {
    settingsLine: `${TESTED_AGENTIC_LINE} Using ${input.model}, which hasn't been tested with Agentic Ask.`,
    settingsWarning: null,
    composerWarning: null,
  };
}
