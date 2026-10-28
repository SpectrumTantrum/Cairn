// Slide text and speaker notes of a .pptx package. Each slide becomes an ATX
// heading so chunking and citations match notes: `# Slide N · <title>`.
// Slide numbers follow `p:sldIdLst` order, including hidden slides. Masters,
// layouts, comments, charts, SmartArt, pictures, and alt text stay out.
// .ppt, .pptm, .ppsx, and .potx are not read.

import { readFileSync } from "node:fs";
import { parse, NodeType, type HTMLElement, type Node } from "node-html-parser";
import { readZipEntry, ZipError } from "./zip-read.js";

export const PPTX_NO_TEXT = "This PowerPoint file has no readable text, so Cairn cannot read it.";
export const PPTX_UNREADABLE = "This PowerPoint file is password-protected or damaged, so Cairn cannot read it.";
/** Extracted text is refused past this so a huge deck cannot fill memory. */
export const PPTX_TEXT_CAP = 2 * 1024 * 1024;
/** Decks with more slides than this are refused. PowerPoint files stay bounded. */
export const PPTX_SLIDE_CAP = 2000;

const NOTES_SKIP = new Set(["sldnum", "hdr", "ftr", "dt", "sldimg"]);

interface SlideRef {
  rid: string;
  hidden: boolean;
}

interface Rel {
  type: string;
  target: string;
}

export function isPptxPath(path: string): boolean {
  return path.toLowerCase().endsWith(".pptx");
}

/**
 * One block per slide heading in `extractPptxText` output.
 * `startLine` is the 1-based line of that heading in the full extract.
 */
export function splitPptxSlides(text: string): { text: string; startLine: number }[] {
  const lines = text.split("\n");
  const ranges: { start: number; end: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^# Slide \d+\b/.test(lines[i])) {
      if (ranges.length > 0) ranges[ranges.length - 1].end = i;
      ranges.push({ start: i, end: lines.length });
    }
  }
  if (ranges.length === 0) return text.trim() ? [{ text, startLine: 1 }] : [];
  return ranges.map((range) => ({
    text: lines.slice(range.start, range.end).join("\n"),
    startLine: range.start + 1,
  }));
}

function tagOf(node: HTMLElement): string {
  return (node.rawTagName || node.tagName || "").toLowerCase();
}

function isElement(node: Node): node is HTMLElement {
  return node.nodeType === NodeType.ELEMENT_NODE;
}

function attr(el: HTMLElement | undefined, name: string): string {
  if (!el) return "";
  const direct = el.getAttribute(name) ?? el.getAttribute(name.toLowerCase());
  if (direct) return direct;
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(el.attributes ?? {})) {
    if (key.toLowerCase() === want && value) return value;
  }
  return "";
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

function phType(sp: HTMLElement): string {
  let found = "";
  walk(sp, (el) => {
    if (!found && tagOf(el) === "p:ph") found = attr(el, "type");
  });
  return found;
}

function isTitlePh(type: string): boolean {
  const name = type.toLowerCase();
  return name === "title" || name === "ctrtitle";
}

function paragraphLines(p: HTMLElement): string[] {
  const lines = [""];
  const push = (value: string) => {
    lines[lines.length - 1] += value;
  };
  const visit = (node: Node): void => {
    if (!isElement(node)) return;
    const tag = tagOf(node);
    if (tag === "a:br") {
      lines.push("");
      return;
    }
    if (tag === "a:tab") {
      push("\t");
      return;
    }
    if (tag === "a:t") {
      push(node.text ?? "");
      return;
    }
    for (const child of node.childNodes) visit(child);
  };
  for (const child of p.childNodes) visit(child);
  return lines.map((line) => line.replace(/\u00a0/g, " ").trim()).filter((line) => line.length > 0);
}

function txBodyLines(root: HTMLElement, bodyTag: string): string[] {
  const lines: string[] = [];
  walk(root, (el) => {
    if (tagOf(el) !== bodyTag) return;
    for (const child of el.childNodes) {
      if (isElement(child) && tagOf(child) === "a:p") lines.push(...paragraphLines(child));
    }
  });
  return lines;
}

function shapeLines(sp: HTMLElement): string[] {
  return txBodyLines(sp, "p:txbody");
}

function cellText(tc: HTMLElement): string {
  return txBodyLines(tc, "a:txbody").join(" ").replace(/\s+/g, " ").trim();
}

function tableLines(frame: HTMLElement): string[] {
  const lines: string[] = [];
  walk(frame, (el) => {
    if (tagOf(el) !== "a:tbl") return;
    for (const row of el.childNodes) {
      if (!isElement(row) || tagOf(row) !== "a:tr") continue;
      const cells: string[] = [];
      for (const cell of row.childNodes) {
        if (isElement(cell) && tagOf(cell) === "a:tc") cells.push(cellText(cell));
      }
      if (cells.some((cell) => cell.length > 0)) lines.push(cells.join(" | "));
    }
  });
  return lines;
}

type ShapeItem = { kind: "shape"; el: HTMLElement } | { kind: "frame"; el: HTMLElement };

function collectShapes(node: Node, out: ShapeItem[]): void {
  if (!isElement(node)) {
    for (const child of node.childNodes) collectShapes(child, out);
    return;
  }
  const tag = tagOf(node);
  if (tag === "p:sp") {
    out.push({ kind: "shape", el: node });
    return;
  }
  if (tag === "p:graphicframe") {
    out.push({ kind: "frame", el: node });
    return;
  }
  if (tag === "p:pic" || tag === "p:cxnsp") return;
  if (tag === "mc:alternatecontent") {
    const choice = childTag(node, "mc:choice");
    const fallback = childTag(node, "mc:fallback");
    const before = out.length;
    if (choice) collectShapes(choice, out);
    if (out.length === before && fallback) collectShapes(fallback, out);
    return;
  }
  for (const child of node.childNodes) collectShapes(child, out);
}

function slideContent(xml: string): { title: string; body: string[] } {
  const items: ShapeItem[] = [];
  collectShapes(parse(xml), items);
  let title = "";
  const body: string[] = [];
  for (const item of items) {
    if (item.kind === "frame") {
      body.push(...tableLines(item.el));
      continue;
    }
    if (isTitlePh(phType(item.el))) {
      if (!title) {
        const text = shapeLines(item.el).join(" ").replace(/\s+/g, " ").trim();
        if (text) title = text;
      }
      continue;
    }
    body.push(...shapeLines(item.el));
  }
  return { title, body };
}

function notesLines(xml: string): string[] {
  const items: ShapeItem[] = [];
  collectShapes(parse(xml), items);
  const lines: string[] = [];
  for (const item of items) {
    if (item.kind !== "shape") continue;
    const type = phType(item.el).toLowerCase();
    if (NOTES_SKIP.has(type) || type !== "body") continue;
    for (const line of shapeLines(item.el)) lines.push(`Notes: ${line}`);
  }
  return lines;
}

function slideHeading(n: number, title: string, hidden: boolean): string {
  const hiddenTag = hidden ? " (hidden)" : "";
  return title ? `Slide ${n} · ${title}${hiddenTag}` : `Slide ${n}${hiddenTag}`;
}

function renderSlide(n: number, slideXml: string, notesXml: string | undefined, hidden: boolean): string {
  const { title, body } = slideContent(slideXml);
  const notes = notesXml ? notesLines(notesXml) : [];
  if (!title && body.length === 0 && notes.length === 0) return "";
  return [`# ${slideHeading(n, title, hidden)}`, ...body, ...notes].join("\n");
}

function relationshipMap(xml: string): Map<string, Rel> {
  const map = new Map<string, Rel>();
  walk(parse(xml), (el) => {
    if (tagOf(el) !== "relationship") return;
    const id = attr(el, "Id");
    const target = attr(el, "Target");
    if (!id || !target) return;
    map.set(id, { type: attr(el, "Type"), target });
  });
  return map;
}

function slideRefs(xml: string): SlideRef[] {
  const refs: SlideRef[] = [];
  walk(parse(xml), (el) => {
    if (tagOf(el) !== "p:sldid") return;
    const show = attr(el, "show").toLowerCase();
    refs.push({
      rid: attr(el, "r:id"),
      hidden: show === "0" || show === "false" || show === "f",
    });
  });
  return refs;
}

function packagePath(basePart: string, target: string): string {
  const clean = target.split("#")[0].split("?")[0].replace(/\\/g, "/");
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    decoded = clean;
  }
  if (decoded.startsWith("/")) return decoded.replace(/^\/+/, "");
  const slash = basePart.lastIndexOf("/");
  const dir = slash === -1 ? "" : basePart.slice(0, slash);
  const combined = dir ? `${dir}/${decoded}` : decoded;
  const stack: string[] = [];
  for (const part of combined.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

function relsPath(part: string): string {
  const slash = part.lastIndexOf("/");
  const dir = slash === -1 ? "" : part.slice(0, slash + 1);
  const base = slash === -1 ? part : part.slice(slash + 1);
  return `${dir}_rels/${base}.rels`;
}

function unreadable(): Error {
  return new Error(PPTX_UNREADABLE);
}

function readPart(data: Buffer, name: string): string {
  try {
    return readZipEntry(data, name).toString("utf8");
  } catch (err) {
    if (err instanceof ZipError || err instanceof Error) throw unreadable();
    throw unreadable();
  }
}

function readOptional(data: Buffer, name: string): string | null {
  try {
    return readZipEntry(data, name).toString("utf8");
  } catch (err) {
    if (err instanceof ZipError && err.message.startsWith("missing zip entry")) return null;
    throw unreadable();
  }
}

function notesPart(data: Buffer, slidePart: string): string | null {
  const relsXml = readOptional(data, relsPath(slidePart));
  if (!relsXml) return null;
  for (const rel of relationshipMap(relsXml).values()) {
    if (rel.type.endsWith("/notesSlide")) return packagePath(slidePart, rel.target);
  }
  return null;
}

/** Slide text and speaker notes of a .pptx on disk. Empty text and damaged packages throw. */
export function extractPptxText(abs: string): string {
  let data: Buffer;
  try {
    data = readFileSync(abs);
  } catch {
    throw unreadable();
  }
  const presentation = readPart(data, "ppt/presentation.xml");
  const refs = slideRefs(presentation);
  if (refs.length > PPTX_SLIDE_CAP) throw unreadable();
  if (refs.length === 0) throw new Error(PPTX_NO_TEXT);
  const relsXml = readOptional(data, "ppt/_rels/presentation.xml.rels");
  if (!relsXml) throw unreadable();
  const rels = relationshipMap(relsXml);
  const blocks: string[] = [];
  let length = 0;
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    const rel = ref.rid ? rels.get(ref.rid) : undefined;
    if (!rel) throw unreadable();
    const slidePart = packagePath("ppt/presentation.xml", rel.target);
    if (!slidePart || /^[a-z][a-z0-9+.-]*:/i.test(rel.target)) throw unreadable();
    const slideXml = readPart(data, slidePart);
    const notes = notesPart(data, slidePart);
    const notesXml = notes ? readPart(data, notes) : undefined;
    const block = renderSlide(i + 1, slideXml, notesXml, ref.hidden);
    if (!block) continue;
    const extra = (blocks.length > 0 ? 1 : 0) + block.length;
    if (length + extra > PPTX_TEXT_CAP) throw unreadable();
    blocks.push(block);
    length += extra;
  }
  if (blocks.length === 0) throw new Error(PPTX_NO_TEXT);
  return blocks.join("\n");
}
