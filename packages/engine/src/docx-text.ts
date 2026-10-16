// Body text of a .docx package. Headings become ATX lines so chunking and
// citations match notes. Headers, footers, comments, footnotes, deletions,
// and drawings stay out. .doc, .docm, and .dotx are not read.

import { readFileSync } from "node:fs";
import { parse, NodeType, type HTMLElement, type Node } from "node-html-parser";
import { readZipEntry, ZipError } from "./zip-read.js";

export const DOCX_NO_TEXT = "This Word file has no readable text, so Cairn cannot read it.";
export const DOCX_UNREADABLE = "This Word file is password-protected or damaged, so Cairn cannot read it.";
/** Extracted text is cut here so a huge document cannot fill memory. */
export const DOCX_TEXT_CAP = 2 * 1024 * 1024;

const SKIP = new Set([
  "w:del",
  "w:drawing",
  "w:object",
  "w:pict",
  "w:hdr",
  "w:ftr",
  "w:commentreference",
  "w:footnotereference",
  "w:endnotereference",
]);

interface StyleInfo {
  name: string;
  outline: number | null;
}

export function isDocxPath(path: string): boolean {
  return path.toLowerCase().endsWith(".docx");
}

export function limitDocxText(text: string, cap = DOCX_TEXT_CAP): string {
  return text.length <= cap ? text : text.slice(0, cap);
}

function tagOf(node: HTMLElement): string {
  return (node.rawTagName || "").toLowerCase();
}

function isElement(node: Node): node is HTMLElement {
  return node.nodeType === NodeType.ELEMENT_NODE;
}

function attr(el: HTMLElement | undefined, name: string): string {
  if (!el) return "";
  return el.getAttribute(name) ?? el.getAttribute(name.toLowerCase()) ?? "";
}

function childTag(el: HTMLElement, tag: string): HTMLElement | undefined {
  for (const child of el.childNodes) {
    if (isElement(child) && tagOf(child) === tag) return child;
  }
  return undefined;
}

function walk(node: Node, fn: (el: HTMLElement) => void): void {
  if (!isElement(node)) {
    for (const child of node.childNodes) walk(child, fn);
    return;
  }
  fn(node);
  for (const child of node.childNodes) walk(child, fn);
}

function findTag(node: Node, tag: string): HTMLElement | undefined {
  let found: HTMLElement | undefined;
  walk(node, (el) => {
    if (!found && tagOf(el) === tag) found = el;
  });
  return found;
}

function levelFromHeadingName(name: string): number | null {
  const compact = name.replace(/[\s_]+/g, "");
  const match = /^heading([1-6])$/i.exec(compact);
  if (match) return Number(match[1]);
  if (/^title$/i.test(compact)) return 1;
  return null;
}

function outlineLevel(raw: string): number | null {
  if (raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 5) return null;
  return n + 1;
}

function styleMap(xml: string | undefined): Map<string, StyleInfo> {
  const map = new Map<string, StyleInfo>();
  if (!xml?.trim()) return map;
  const root = parse(xml);
  walk(root, (el) => {
    if (tagOf(el) !== "w:style") return;
    const id = attr(el, "w:styleId");
    if (!id) return;
    let name = "";
    let outline: number | null = null;
    walk(el, (inner) => {
      const tag = tagOf(inner);
      if (tag === "w:name" && !name) name = attr(inner, "w:val");
      if (tag === "w:outlinelvl" && outline === null) outline = outlineLevel(attr(inner, "w:val"));
    });
    map.set(id, { name, outline });
  });
  return map;
}

function headingLevel(p: HTMLElement, styles: Map<string, StyleInfo>): number | null {
  const pPr = childTag(p, "w:ppr");
  const styleId = attr(pPr ? childTag(pPr, "w:pstyle") : undefined, "w:val");
  if (styleId) {
    const fromId = levelFromHeadingName(styleId);
    if (fromId) return fromId;
    const info = styles.get(styleId);
    if (info) {
      const fromName = levelFromHeadingName(info.name);
      if (fromName) return fromName;
      if (info.outline !== null) return info.outline;
    }
  }
  return outlineLevel(attr(pPr ? childTag(pPr, "w:outlinelvl") : undefined, "w:val"));
}

function inlineText(node: Node): string {
  if (node.nodeType === NodeType.TEXT_NODE) return node.text ?? "";
  if (!isElement(node)) return "";
  const tag = tagOf(node);
  if (SKIP.has(tag)) return "";
  if (tag === "w:tab") return "\t";
  if (tag === "w:br" || tag === "w:cr") return "\n";
  let out = "";
  for (const child of node.childNodes) out += inlineText(child);
  return out;
}

function paragraphLine(p: HTMLElement, styles: Map<string, StyleInfo>): string {
  const level = headingLevel(p, styles);
  let text = inlineText(p).replace(/\u00a0/g, " ");
  text = level ? text.replace(/\s+/g, " ").trim() : text.replace(/[ ]+\n/g, "\n").replace(/\n[ ]+/g, "\n").trim();
  if (!text) return "";
  return level ? `${"#".repeat(level)} ${text}` : text;
}

function cellText(tc: HTMLElement): string {
  return inlineText(tc).replace(/\n+/g, " ").replace(/ {2,}/g, " ").trim();
}

function tableLines(tbl: HTMLElement): string[] {
  const lines: string[] = [];
  for (const child of tbl.childNodes) {
    if (!isElement(child) || tagOf(child) !== "w:tr") continue;
    const cells: string[] = [];
    for (const cell of child.childNodes) {
      if (isElement(cell) && tagOf(cell) === "w:tc") cells.push(cellText(cell));
    }
    if (cells.some((cell) => cell.length > 0)) lines.push(cells.join(" | "));
  }
  return lines;
}

function blockLines(el: HTMLElement, styles: Map<string, StyleInfo>): string[] {
  const lines: string[] = [];
  for (const child of el.childNodes) {
    if (!isElement(child)) continue;
    const tag = tagOf(child);
    if (SKIP.has(tag) || tag === "w:sectpr") continue;
    if (tag === "w:p") {
      const line = paragraphLine(child, styles);
      if (line) lines.push(line);
      continue;
    }
    if (tag === "w:tbl") {
      lines.push(...tableLines(child));
      continue;
    }
    lines.push(...blockLines(child, styles));
  }
  return lines;
}

/** Visible body text, or "" when the document has no paragraphs. */
export function renderDocxXml(documentXml: string, stylesXml?: string): string {
  const root = parse(documentXml);
  const body = findTag(root, "w:body");
  if (!body) return "";
  return blockLines(body, styleMap(stylesXml)).join("\n");
}

function unreadable(): Error {
  return new Error(DOCX_UNREADABLE);
}

/** Body text of a .docx on disk. Empty text and damaged packages throw. */
export function extractDocxText(abs: string): string {
  let data: Buffer;
  try {
    data = readFileSync(abs);
  } catch {
    throw unreadable();
  }
  let documentXml: string;
  try {
    documentXml = readZipEntry(data, "word/document.xml").toString("utf8");
  } catch (err) {
    if (err instanceof ZipError || err instanceof Error) throw unreadable();
    throw unreadable();
  }
  let stylesXml: string | undefined;
  try {
    stylesXml = readZipEntry(data, "word/styles.xml").toString("utf8");
  } catch {
    stylesXml = undefined;
  }
  const text = renderDocxXml(documentXml, stylesXml);
  if (!text.trim()) throw new Error(DOCX_NO_TEXT);
  return limitDocxText(text);
}
