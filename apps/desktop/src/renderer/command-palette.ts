// Command-palette filter + keyboard-navigation logic (issue #13). Kept pure — no React,
// no DOM — so the "which commands match this query?" and "where does the arrow key move
// the active row?" rules can be unit-tested in isolation. App.tsx builds the command list
// (each command carrying its own `run` closure) and the CommandPalette component renders it;
// this module owns only the decisions those two wire together.

/** The minimal shape the filter needs. Real commands (in App) extend this with `run`, ARIA ids, etc. */
export interface CommandFilterItem {
  /** Primary label shown in the palette and matched against the query. */
  title: string;
  /** Extra search terms (synonyms, category) matched but not necessarily shown. */
  keywords?: string;
}

/** Lowercased "title + keywords" haystack a query is matched against. */
export function commandHaystack(cmd: CommandFilterItem): string {
  return `${cmd.title} ${cmd.keywords ?? ""}`.toLowerCase();
}

/**
 * Filter-as-you-type: an empty/whitespace query returns every command (palette shows all).
 * Otherwise the query is split on whitespace and EVERY term must appear (substring) in the
 * command's haystack, so "idx vault" and "vault index" both find "Index vault". Input order
 * is preserved — the command list defines its own priority.
 */
export function filterCommands<T extends CommandFilterItem>(commands: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return commands;
  const terms = q.split(/\s+/);
  return commands.filter((c) => {
    const hay = commandHaystack(c);
    return terms.every((t) => hay.includes(t));
  });
}

/**
 * Next active row index after an arrow key, with wrap-around. `delta` is +1 (ArrowDown) or
 * -1 (ArrowUp). An empty result list pins the index at 0 so callers never index into nothing.
 */
export function nextActiveIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (((current + delta) % length) + length) % length;
}

/**
 * Re-clamp the active index when the result list changes size under it (filter narrowed the
 * list, so the old index may now point past the end). Keeps the selection on a real row.
 */
export function clampActiveIndex(current: number, length: number): number {
  if (length <= 0) return 0;
  if (current < 0) return 0;
  if (current > length - 1) return length - 1;
  return current;
}
