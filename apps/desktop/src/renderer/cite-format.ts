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

/** Plain UTF-8 text. Opens in the editor at a line, and is not a Markdown write target. */
export function isPlainTextPath(file: string): boolean {
  return file.toLowerCase().endsWith(".txt");
}

/** HTML vault file. Opens in the editor at a line, and is not a Markdown write target. */
export function isHtmlPath(file: string): boolean {
  return /\.html?$/i.test(file);
}

/** CSV or TSV. Opens in the editor at a line, and is not a Markdown write target. */
export function isTablePath(file: string): boolean {
  return /\.(csv|tsv)$/i.test(file);
}

/** png, jpg, jpeg, webp, or gif. Opens in the in-app image viewer, not the editor. */
export function isImagePath(file: string): boolean {
  return /\.(png|jpe?g|webp|gif)$/i.test(file);
}

/** mp3, wav, or m4a. Opens in the in-app audio player, not the editor. */
export function isAudioPath(file: string): boolean {
  return /\.(mp3|wav|m4a)$/i.test(file);
}

/** mp4, webm, or mov. Opens in the in-app video player, not the editor. */
export function isVideoPath(file: string): boolean {
  return /\.(mp4|webm|mov)$/i.test(file);
}

/** Editor buffer that Ask can cite but the user cannot save (edit only Markdown). */
export function isReadOnlyEditorPath(file: string): boolean {
  return isPlainTextPath(file) || isHtmlPath(file) || isTablePath(file);
}

/** Markdown notes, plain text, CSV, TSV, and HTML open in the editor. PDFs use the viewer. */
export function opensInEditor(file: string): boolean {
  return /\.(md|markdown|txt|csv|tsv|html|htm)$/i.test(file);
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
 * Visible chip when the caller has no open handler. Stays the location label
 * (`notes.md:4 › Heading`, `report.pdf p.3`). Never a paragraph, "undefined",
 * or an error sentence.
 */
export interface CitationChipFace {
  /** False when nothing can open this chip. Render it as a label, not a button. */
  interactive: boolean;
  text: string;
  title: string;
}

export function citationChipFace(
  hit: { file: string; line: number; heading?: string; page?: number },
  handler: boolean,
): CitationChipFace {
  const page = isPdfPath(hit.file) && hit.page && hit.page > 0 ? hit.page : 0;
  const heading = (hit.heading ?? "").trim();
  const text =
    page > 0
      ? pdfChipLabel(hit.file, page)
      : `${basename(hit.file)}:${citationLineLabel(hit.line)}${heading ? ` › ${heading}` : ""}`;
  const title = handler ? citationTitle(hit.file, hit.line, heading, page > 0 ? page : undefined) : text;
  return { interactive: handler, text, title };
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
