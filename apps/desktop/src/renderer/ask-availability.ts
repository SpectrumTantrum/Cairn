// Composer-disabled messaging (issue #14). Kept pure — no React, no I/O — so the exact
// copy each unavailable state shows can be unit-tested. App.tsx wires the returned string
// into the `composerReason` useMemo; Composer renders it under the input (the `warn`
// styling still keys off `!ollamaUp` at the call site). The load-bearing line is the
// Ollama-down case: it must tell the user that vault SEARCH still works without AI, so a
// missing local model reads as "Ask is unavailable", not "Cairn is broken".

/** Minimal view of the availability signals the composer copy depends on. */
export interface AskAvailability {
  /** A vault folder is selected. */
  hasVault: boolean;
  /** The selected vault has a built index. */
  indexed: boolean;
  /** Local Ollama is reachable with a chat model. */
  ollamaUp: boolean;
}

/**
 * The reason the Ask composer is inert, or null when Ask is available. Order matters:
 * no vault → not indexed → Ollama down. The Ollama-down copy is deliberately reassuring
 * (search still works) and keeps the local-first privacy line intact.
 */
export function composerDisabledReason(a: AskAvailability): string | null {
  if (!a.hasVault) return "Choose a vault to ask grounded questions.";
  if (!a.indexed) return "Index this vault before asking (status bar, bottom of the editor).";
  if (!a.ollamaUp)
    return "Ask needs local Ollama running with a chat model — but vault search still works without AI. No cloud calls are ever made.";
  return null;
}
