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

/**
 * The in-app PDF viewer is asked to open at `#page=N`. The tooltip says
 * "Open <path> at page N" only while this is true.
 * Verified on Electron 42: a WebContentsView load of `file://…pdf#page=3`
 * reports page 3, and the same file without the fragment reports page 1.
 * Flip this off if QA sees the viewer open on a different page.
 */
export const PDF_OPEN_LANDS_ON_PAGE = true;

export function isPdfPath(file: string): boolean {
  return file.toLowerCase().endsWith(".pdf");
}

/** Chip text for a PDF page, e.g. `report.pdf p.3`. */
export function pdfChipLabel(file: string, page: number): string {
  return `${basename(file)} p.${page}`;
}

/**
 * Hover title for a PDF. `landsOnPage` defaults to the shipped switch.
 * Tests pass true or false to lock both wordings.
 */
export function pdfOpenTitle(file: string, page?: number, landsOnPage = PDF_OPEN_LANDS_ON_PAGE): string {
  if (landsOnPage && page !== undefined && page > 0) return `Open ${file} at page ${page}`;
  return `Open ${file}`;
}

/**
 * Hover title for a citation open target.
 * A located passage is "Open <path> at line <n> › <heading>" when a heading is known.
 * The line is the click target (the heading line), not a later fact line.
 * An unmatched note is "Open <path> (file)".
 * A PDF uses `pdfOpenTitle` and does not claim a line.
 */
export function citationTitle(file: string, line: number, heading = "", page?: number): string {
  if (isPdfPath(file)) return pdfOpenTitle(file, page);
  if (line <= 0) return `Open ${file} (file)`;
  const title = heading.trim();
  if (title) return `Open ${file} at line ${line} › ${title}`;
  return `Open ${file} at line ${line}`;
}

/** Vault-relative paths that refer to the same note (case-insensitive, for cite ↔ editor match). */
export function vaultPathsEqual(a: string, b: string): boolean {
  return a === b || a.toLowerCase() === b.toLowerCase();
}
