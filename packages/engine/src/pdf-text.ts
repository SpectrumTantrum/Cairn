// Born-digital PDF text for agentic Ask. One page at a time, via pdf.js
// getTextContent. Pages with no text layer are omitted. No OCR, no images,
// no embeddings.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

declare module "pdfjs-dist/legacy/build/pdf.mjs" {
  interface PdfJsTextItem {
    str?: string;
    hasEOL?: boolean;
  }
  interface PdfJsPage {
    getTextContent(): Promise<{ items: PdfJsTextItem[] }>;
  }
  interface PdfJsDoc {
    numPages: number;
    getPage(page: number): Promise<PdfJsPage>;
    destroy(): Promise<void>;
  }
  export function getDocument(src: {
    data: Uint8Array;
    disableWorker?: boolean;
    isEvalSupported?: boolean;
    standardFontDataUrl?: string;
    verbosity?: number;
  }): { promise: Promise<PdfJsDoc> };
}

const require = createRequire(import.meta.url);

export interface PdfPageText {
  /** 1-based page number in the PDF. */
  page: number;
  text: string;
}

export class PdfTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfTextError";
  }
}

function standardFontDir(): string {
  const pkg = require.resolve("pdfjs-dist/package.json");
  const dir = pkg.replace(/package\.json$/, "standard_fonts/");
  // db-style asar rewrite: the packaged font files live under app.asar.unpacked.
  return dir.replace(/\.asar([\\/])/, ".asar.unpacked$1");
}

/** Join pdf.js text items into lines. hasEOL marks a line break. */
export function textFromItems(items: readonly { str?: string; hasEOL?: boolean }[]): string {
  const lines: string[] = [];
  let current = "";
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    current += item.str;
    if (item.hasEOL) {
      lines.push(current);
      current = "";
    }
  }
  if (current) lines.push(current);
  return lines
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .trim();
}

/**
 * Extract plain text from a PDF on disk.
 * Empty pages are skipped. A password-protected file throws PdfTextError.
 * A file with no text layer returns [].
 */
export async function extractPdfPages(absPath: string): Promise<PdfPageText[]> {
  const data = new Uint8Array(readFileSync(absPath));
  let doc;
  try {
    doc = await getDocument({
      data,
      disableWorker: true,
      isEvalSupported: false,
      standardFontDataUrl: standardFontDir(),
      verbosity: 0,
    }).promise;
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "PasswordException") {
      throw new PdfTextError("This PDF is password-protected, so Cairn cannot read it.");
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new PdfTextError(`Cairn could not read this PDF. ${message}`);
  }

  try {
    const pages: PdfPageText[] = [];
    for (let page = 1; page <= doc.numPages; page++) {
      const pdfPage = await doc.getPage(page);
      const content = await pdfPage.getTextContent();
      const text = textFromItems(content.items);
      if (text) pages.push({ page, text });
    }
    return pages;
  } finally {
    await doc.destroy();
  }
}

/** First short line of a page, used as the chunk heading when the page has no Markdown heading. */
export function pdfPageHeading(text: string): string {
  const line = text.split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? "";
  if (!line || line.length > 80) return "";
  return line;
}
