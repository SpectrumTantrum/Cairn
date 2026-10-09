import { pathToFileURL } from "node:url";

/**
 * file:// URL for the in-app PDF viewer. `page` is 1-based.
 * The fragment is always requested; the tooltip claims the landing only when
 * `PDF_OPEN_LANDS_ON_PAGE` in cite-format.ts is on.
 */
export function pdfFileUrl(absPath: string, page?: number): string {
  const base = pathToFileURL(absPath).href;
  if (page !== undefined && page > 0) return `${base}#page=${page}`;
  return base;
}
