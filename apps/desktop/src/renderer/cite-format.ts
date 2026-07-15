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

/** Hover title for a citation open target: "Open <path> at line <n>". */
export function citationTitle(file: string, line: number): string {
  return `Open ${file} at line ${line}`;
}
