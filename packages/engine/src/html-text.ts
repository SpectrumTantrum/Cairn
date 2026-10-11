// Visible text of a vault HTML file. Scripts, styles, and tags are removed.
// Headings stay as ATX lines so chunking and citations match notes and .txt.
// node-html-parser (MIT) does the parse; this file only walks the tree.

import { parse, NodeType, type HTMLElement, type Node } from "node-html-parser";

/** Thrown when a `.html` / `.htm` file yields no visible text. The tool prefixes `ERROR:`. */
export const HTML_NO_TEXT = "This HTML file has no readable text, so Cairn cannot read it.";

const SKIP_TAGS = new Set(["script", "style", "template", "svg", "canvas", "iframe"]);

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "header",
  "hgroup",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

function isElement(node: Node): node is HTMLElement {
  return node.nodeType === NodeType.ELEMENT_NODE;
}

function tagOf(node: HTMLElement): string {
  return (node.rawTagName || "").toLowerCase();
}

function skipped(node: HTMLElement): boolean {
  const tag = tagOf(node);
  if (!tag) return false;
  if (tag === "head" || SKIP_TAGS.has(tag)) return true;
  if (node.hasAttribute("hidden")) return true;
  if (tag === "input" && (node.getAttribute("type") || "").toLowerCase() === "hidden") return true;
  return false;
}

function tidy(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function joinChildren(node: HTMLElement): string {
  let out = "";
  for (const child of node.childNodes) out += render(child);
  return out;
}

function inlineText(node: Node): string {
  if (node.nodeType === NodeType.TEXT_NODE) return node.text ?? "";
  if (node.nodeType === NodeType.COMMENT_NODE) return "";
  if (!isElement(node) || skipped(node)) return "";
  if (tagOf(node) === "br") return " ";
  let out = "";
  for (const child of node.childNodes) out += inlineText(child);
  return out;
}

function preText(node: Node): string {
  if (node.nodeType === NodeType.TEXT_NODE) return node.text ?? "";
  if (node.nodeType === NodeType.COMMENT_NODE) return "";
  if (!isElement(node) || skipped(node)) return "";
  if (tagOf(node) === "br") return "\n";
  let out = "";
  for (const child of node.childNodes) out += preText(child);
  return out;
}

function render(node: Node): string {
  if (node.nodeType === NodeType.COMMENT_NODE) return "";
  if (node.nodeType === NodeType.TEXT_NODE) {
    const raw = node.text ?? "";
    if (/^<!doctype\b/i.test(raw.trim())) return "";
    return raw.replace(/[ \t\f\v]+/g, " ");
  }
  if (!isElement(node)) return "";
  if (!tagOf(node)) return joinChildren(node);
  if (skipped(node)) return "";

  const tag = tagOf(node);
  const heading = /^h([1-6])$/.exec(tag);
  if (heading) {
    const text = inlineText(node).replace(/\s+/g, " ").trim();
    if (!text) return "";
    return `\n\n${"#".repeat(Number(heading[1]))} ${text}\n\n`;
  }
  if (tag === "br") return "\n";
  if (tag === "pre") {
    const text = preText(node).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) return "";
    return `\n\n${text}\n\n`;
  }
  if (BLOCK_TAGS.has(tag)) {
    const inner = tidy(joinChildren(node));
    if (!inner) return "";
    return `\n\n${inner}\n\n`;
  }
  return joinChildren(node);
}

/** Visible text, or "" when the document has nothing to read. */
export function extractHtmlText(html: string): string {
  return tidy(render(parse(html)));
}
