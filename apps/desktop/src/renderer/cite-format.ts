/**
 * Shared formatting helpers for the citation card (issue #15). Pure string logic, kept out
 * of the React component so it can be gated with `node --test` (the rendering itself has no
 * harness). Reused by search results, chat citation pills, and Sources-tab rows via
 * `CitationCard`.
 */

/** Final path segment (the filename) of a vault-relative path. */
export function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/** Short uppercase file-type chip from a path's extension (MD / PDF / AV / …). */
export function typeChip(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "md") return "MD";
  if (ext === "pdf") return "PDF";
  if (["mp3", "wav", "m4a", "mp4", "mov", "webm"].includes(ext)) return "AV";
  return ext.toUpperCase();
}

/**
 * Line stored on a citation that could not be matched to a passage.
 * The chip and tooltip say "file"; opening the note still lands at the top.
 */
export const FILE_CITE_LINE = 0;

/** Chip suffix: a real line number, or "file" when the passage could not be matched. */
export function citationLineLabel(line: number): string {
  return line > 0 ? String(line) : "file";
}

/** Hover title for a citation open target: "Open <path> at line <n>", or "(file)". */
export function citationTitle(file: string, line: number): string {
  if (line > 0) return `Open ${file} at line ${line}`;
  return `Open ${file} (file)`;
}

/** Vault-relative paths that refer to the same note (case-insensitive, for cite ↔ editor match). */
export function vaultPathsEqual(a: string, b: string): boolean {
  return a === b || a.toLowerCase() === b.toLowerCase();
}
