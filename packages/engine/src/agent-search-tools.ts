// HoP-approved read-only vault tools for agentic Ask/search (list / find / grep / read / open).
// Executed inside a bounded tool loop; the engine never writes. `open` records UI anchors
// for the desktop to jump to — it does not mutate the vault.

import { search } from "./retrieve.js";
import type { Mode, SearchHit } from "./retrieve.js";
import type { Index } from "./vault-index.js";
import type { ToolSchema } from "./model-provider.js";
import { pdfPageHeading } from "./pdf-text.js";

export const ASK_SEARCH_TOOL_NAMES = ["list", "find", "grep", "read", "open"] as const;
export type AskSearchToolName = (typeof ASK_SEARCH_TOOL_NAMES)[number];

/** UI anchor the client can use to open a note at a heading or line (ADR-0010 citation click-through). */
export interface OpenAnchor {
  path: string;
  line?: number;
  heading?: string;
  /** 1-based PDF page. Absent for Markdown. */
  page?: number;
}

export interface AskSearchToolContext {
  index: Index;
  readNote: (path: string) => Promise<string>;
  /**
   * Per-page text of a vault PDF. Empty means the file has no text layer.
   * Markdown reads stay on `readNote`.
   */
  readPdf?: (path: string) => Promise<{ page: number; text: string }[]>;
  /** When set, `list` uses the live vault tree; otherwise indexed paths only. */
  listNotes?: (prefix?: string) => Promise<string[]>;
  scope?: string[];
  defaultMode?: Mode;
  defaultK?: number;
  maxReadChars?: number;
  grepLimit?: number;
}

export interface AskSearchToolState {
  /** Sources surfaced to the model and returned as citations metadata. */
  sources: SearchHit[];
  /** Distinct open targets the agent requested (for UI). */
  opened: OpenAnchor[];
  /** A read or open touched a PDF that extracted no text. */
  textlessPdf?: boolean;
}

const MAX_READ_CHARS_DEFAULT = 8000;
const GREP_LIMIT_DEFAULT = 20;
const PDF_NO_TEXT = "ERROR: This PDF has no text layer, so Cairn cannot read it.";

function isPdfPath(path: string): boolean {
  return path.toLowerCase().endsWith(".pdf");
}

export const ASK_SEARCH_TOOLS: ToolSchema[] = [
  {
    name: "list",
    description:
      "List Markdown note and PDF paths in the vault. Optional prefix filters to paths starting with that folder prefix (vault-relative POSIX paths).",
    parameters: {
      type: "object",
      properties: {
        prefix: { type: "string", description: "Optional vault-relative folder prefix, e.g. notes/courses" },
      },
    },
  },
  {
    name: "find",
    description:
      "Search the indexed vault for relevant chunks (hybrid dense+keyword when available, else keyword). PDF chunks are keyword-only and include a page. Returns ranked snippets with file, line, heading, and page when the source is a PDF.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language or keyword search query" },
        k: { type: "integer", description: "Max results (1–20)", default: 8 },
      },
      required: ["query"],
    },
  },
  {
    name: "grep",
    description:
      "Substring search over indexed chunk text (case-insensitive). Each hit is the line where the pattern matched and the nearest heading at or above that line, not the start of the chunk. PDF hits include a page. Optional path limits to one file.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Substring to match (case-insensitive)" },
        path: { type: "string", description: "Optional vault-relative note path to search within" },
        limit: { type: "integer", description: "Max matches (1–30)", default: 20 },
      },
      required: ["pattern"],
    },
  },
  {
    name: "read",
    description:
      "Read a Markdown note, or the text of each page of a PDF. A PDF with no text layer cannot be read. Use after find/grep to read surrounding context.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative path, e.g. notes/topic.md" },
      },
      required: ["path"],
    },
  },
  {
    name: "open",
    description:
      "Record a UI open target (path, optional line or heading, and for a PDF the 1-based page). Call when you cite a specific location the user should jump to.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative path" },
        line: { type: "integer", description: "1-based line number in a Markdown note" },
        heading: { type: "string", description: "Heading text to scroll to when line is unknown" },
        page: { type: "integer", description: "1-based PDF page. Required when citing a PDF." },
      },
      required: ["path"],
    },
  },
];

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Folder prefix for `list`: POSIX path without trailing slashes. */
function normalizeListPrefix(prefix: string): string {
  const norm = normalizePath(prefix.trim());
  return norm.replace(/\/+$/, "");
}

function sourceKey(hit: Pick<SearchHit, "file" | "line" | "heading" | "page">): string {
  return `${hit.file}:${hit.line}:${hit.heading}:${hit.page ?? ""}`;
}

function sourceRef(state: AskSearchToolState, hit: Pick<SearchHit, "file" | "line" | "heading" | "page">): number {
  const idx = state.sources.findIndex((s) => sourceKey(s) === sourceKey(hit));
  return idx >= 0 ? idx + 1 : 0;
}

function filterPathsByScope(paths: string[], scope?: readonly string[]): string[] {
  if (scope === undefined || scope.length === 0) return paths;
  const allowed = new Set(scope.map((p) => normalizePath(p)));
  return paths.filter((p) => allowed.has(normalizePath(p)));
}

function indexedFiles(index: Index, scope?: readonly string[]): string[] {
  const files = index.listFiles(scope);
  return [...files].sort((a, b) => a.localeCompare(b));
}

function mergeSource(state: AskSearchToolState, hit: SearchHit): void {
  const key = sourceKey(hit);
  if (state.sources.some((s) => sourceKey(s) === key)) return;
  state.sources.push(hit);
}

function snippet(text: string, max = 160): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

async function loadPdfPages(
  ctx: AskSearchToolContext,
  path: string,
): Promise<{ page: number; text: string }[] | string> {
  if (!ctx.readPdf) return "ERROR: PDF reading is not available.";
  try {
    const pages = await ctx.readPdf(path);
    if (pages.length === 0) return PDF_NO_TEXT;
    return pages;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `ERROR: ${message}`;
  }
}

function pageHit(file: string, page: { page: number; text: string }, arms: string): SearchHit {
  return {
    file,
    line: 1,
    heading: pdfPageHeading(page.text),
    page: page.page,
    score: NaN,
    cosine: NaN,
    snippet: snippet(page.text),
    text: page.text,
    arms,
  };
}

function markTextless(state: AskSearchToolState, message: string): void {
  if (message === PDF_NO_TEXT) state.textlessPdf = true;
}

/** ATX heading title, or null when the line is not a heading. */
function atxHeadingTitle(line: string): string | null {
  const m = /^(#{1,6})[ \t]+(.+)$/.exec(line.trimEnd());
  if (!m) return null;
  const title = m[2].replace(/\s+#+\s*$/, "").trim();
  return title.length > 0 ? title : null;
}

/**
 * Where a grep needle sits inside one indexed chunk.
 * `line` is the 1-based line of the first match, not the chunk start.
 * `heading` is the nearest ATX heading at or above that line inside the chunk.
 * A match before any heading keeps the chunk heading (the heading above the
 * chunk, or "" when the note has not started one yet).
 */
function matchInsideChunk(
  chunkLine: number,
  chunkHeading: string,
  text: string,
  needle: string,
): { line: number; heading: string; snippet: string } {
  const at = text.toLowerCase().indexOf(needle);
  if (at < 0) return { line: chunkLine, heading: chunkHeading, snippet: snippet(text) };
  const rel = text.slice(0, at).match(/\n/g)?.length ?? 0;
  const lines = text.split(/\r?\n/);
  let heading = "";
  for (let i = 0; i <= rel && i < lines.length; i++) {
    const title = atxHeadingTitle(lines[i] ?? "");
    if (title) heading = title;
  }
  return {
    line: chunkLine + rel,
    heading: heading || chunkHeading,
    snippet: snippet(lines[rel] ?? text),
  };
}

/**
 * Run one read-only search tool. Mutates `state` (sources/opened) and returns the tool message string.
 */
export async function runAskSearchTool(
  name: string,
  args: Record<string, unknown>,
  ctx: AskSearchToolContext,
  state: AskSearchToolState,
): Promise<string> {
  const maxRead = ctx.maxReadChars ?? MAX_READ_CHARS_DEFAULT;
  const grepLimit = ctx.grepLimit ?? GREP_LIMIT_DEFAULT;

  if (name === "list") {
    const prefixRaw = asString(args.prefix)?.trim() ?? "";
    const prefixNorm = prefixRaw ? normalizeListPrefix(prefixRaw) : "";
    let paths: string[];
    if (ctx.listNotes) {
      paths = await ctx.listNotes(prefixNorm || undefined);
      paths = filterPathsByScope(paths, ctx.scope);
    } else {
      paths = indexedFiles(ctx.index, ctx.scope);
      if (prefixNorm) {
        paths = paths.filter((p) => p === prefixNorm || p.startsWith(`${prefixNorm}/`));
      }
    }
    paths = paths.filter((p) => /\.(md|markdown|pdf)$/i.test(p));
    if (paths.length === 0) return JSON.stringify({ paths: [], note: "No matching notes." });
    return JSON.stringify({ paths, count: paths.length });
  }

  if (name === "find") {
    const query = asString(args.query)?.trim();
    if (!query) return "ERROR: find requires a non-empty string 'query'.";
    const kRaw = args.k === undefined ? (ctx.defaultK ?? 8) : asInt(args.k);
    const k = kRaw === null ? (ctx.defaultK ?? 8) : Math.min(20, Math.max(1, kRaw));
    const { hits, mode } = await search(ctx.index, query, {
      k,
      mode: ctx.defaultMode ?? "auto",
      scope: ctx.scope,
    });
    for (const h of hits) mergeSource(state, h);
    const results = hits.map((h) => ({
      ref: sourceRef(state, h),
      file: h.file,
      line: h.line,
      heading: h.heading || undefined,
      ...(h.page ? { page: h.page } : {}),
      snippet: h.snippet,
    }));
    return JSON.stringify({ mode, results });
  }

  if (name === "grep") {
    const pattern = asString(args.pattern)?.trim();
    if (!pattern) return "ERROR: grep requires a non-empty string 'pattern'.";
    const pathFilter = asString(args.path);
    const limitRaw = args.limit === undefined ? grepLimit : asInt(args.limit);
    const limit = limitRaw === null ? grepLimit : Math.min(30, Math.max(1, limitRaw));
    const needle = pattern.toLowerCase();
    const scope =
      pathFilter !== null && pathFilter !== undefined
        ? [normalizePath(pathFilter)]
        : ctx.scope;
    const matches = ctx.index.grepChunks(needle, limit, scope);
    const located = matches.map((m) => ({
      file: m.file,
      text: m.text,
      page: m.page,
      ...matchInsideChunk(m.line, m.heading, m.text, needle),
    }));
    for (const m of located) {
      mergeSource(state, {
        file: m.file,
        line: m.line,
        heading: m.heading,
        ...(m.page ? { page: m.page } : {}),
        score: NaN,
        cosine: NaN,
        snippet: m.snippet,
        text: m.text,
        arms: "grep",
      });
    }
    return JSON.stringify({
      matches: located.map((m) => ({
        file: m.file,
        line: m.line,
        heading: m.heading || undefined,
        ...(m.page ? { page: m.page } : {}),
        snippet: m.snippet,
      })),
      count: located.length,
    });
  }

  if (name === "read") {
    const path = asString(args.path);
    if (!path) return "ERROR: read requires a string 'path'.";
    const norm = normalizePath(path);
    if (isPdfPath(norm)) {
      const pages = await loadPdfPages(ctx, norm);
      if (typeof pages === "string") {
        markTextless(state, pages);
        return pages;
      }
      for (const page of pages) mergeSource(state, pageHit(norm, page, "read"));
      const body = pages.map((page) => `--- page ${page.page} ---\n${page.text}`).join("\n\n");
      return body.length > maxRead ? `${body.slice(0, maxRead)}\n…(truncated at ${maxRead} chars)` : body;
    }
    try {
      const content = await ctx.readNote(norm);
      const clipped =
        content.length > maxRead ? `${content.slice(0, maxRead)}\n…(truncated at ${maxRead} chars)` : content;
      mergeSource(state, {
        file: norm,
        line: 1,
        heading: "",
        score: NaN,
        cosine: NaN,
        snippet: snippet(content),
        text: clipped,
        arms: "read",
      });
      return clipped;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `ERROR: ${message}`;
    }
  }

  if (name === "open") {
    const path = asString(args.path);
    if (!path) return "ERROR: open requires a string 'path'.";
    const norm = normalizePath(path);
    if (isPdfPath(norm)) {
      const pages = await loadPdfPages(ctx, norm);
      if (typeof pages === "string") {
        markTextless(state, pages);
        return pages;
      }
      const requested = args.page === undefined ? null : asInt(args.page);
      if (args.page !== undefined && requested === null) return "ERROR: open page must be an integer.";
      const page = requested === null ? pages[0] : pages.find((item) => item.page === requested);
      if (!page) return `ERROR: Page ${requested} has no text layer, so Cairn cannot read it.`;
      const heading = asString(args.heading)?.trim() || pdfPageHeading(page.text);
      const anchor: OpenAnchor = { path: norm, page: page.page, ...(heading ? { heading } : {}) };
      if (!state.opened.some((o) => o.path === anchor.path && o.page === anchor.page && o.heading === anchor.heading)) {
        state.opened.push(anchor);
      }
      mergeSource(state, { ...pageHit(norm, page, "open"), heading });
      return JSON.stringify({ recorded: anchor });
    }
    const line = args.line === undefined ? undefined : asInt(args.line);
    const heading = asString(args.heading) ?? undefined;
    const anchor: OpenAnchor = { path: norm, ...(line !== null && line !== undefined ? { line } : {}), ...(heading ? { heading } : {}) };
    if (!state.opened.some((o) => o.path === anchor.path && o.line === anchor.line && o.heading === anchor.heading)) {
      state.opened.push(anchor);
    }
    mergeSource(state, {
      file: norm,
      line: line ?? 1,
      heading: heading ?? "",
      score: NaN,
      cosine: NaN,
      snippet: "",
      text: "",
      arms: "open",
    });
    return JSON.stringify({ recorded: anchor });
  }

  return `ERROR: unknown tool "${name}".`;
}

/** Human-readable one-liner for agentic Ask progress UI. */
export function labelAskSearchToolCall(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "list": {
      const prefix = asString(args.prefix)?.trim();
      return prefix ? `Listed notes under ${prefix}` : "Listed notes in the vault";
    }
    case "find": {
      const query = asString(args.query)?.trim() || "…";
      return `Searched for “${query}”`;
    }
    case "grep": {
      const pattern = asString(args.pattern)?.trim() || "…";
      return `Grepped for “${pattern}”`;
    }
    case "read": {
      const path = asString(args.path)?.trim() || "note";
      return `Read ${path}`;
    }
    case "open": {
      const path = asString(args.path)?.trim() || "note";
      const heading = asString(args.heading)?.trim();
      const line = args.line === undefined ? undefined : asInt(args.line);
      const page = args.page === undefined ? undefined : asInt(args.page);
      if (isPdfPath(path) && page !== null && page !== undefined && page > 0) return `Cited ${path} p.${page}`;
      if (heading) return `Cited ${path} › ${heading}`;
      if (line !== null && line !== undefined && line > 0) return `Cited ${path}:${line}`;
      return `Cited ${path}`;
    }
    default:
      return name;
  }
}
