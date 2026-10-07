// HoP-approved read-only vault tools for agentic Ask/search (list / find / grep / read / open).
// Executed inside a bounded tool loop; the engine never writes. `open` records UI anchors
// for the desktop to jump to — it does not mutate the vault.

import { search } from "./retrieve.js";
import type { Mode, SearchHit } from "./retrieve.js";
import type { Index } from "./vault-index.js";
import type { ToolSchema } from "./model-provider.js";

export const ASK_SEARCH_TOOL_NAMES = ["list", "find", "grep", "read", "open"] as const;
export type AskSearchToolName = (typeof ASK_SEARCH_TOOL_NAMES)[number];

/** UI anchor the client can use to open a note at a heading or line (ADR-0010 citation click-through). */
export interface OpenAnchor {
  path: string;
  line?: number;
  heading?: string;
}

export interface AskSearchToolContext {
  index: Index;
  readNote: (path: string) => Promise<string>;
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
}

const MAX_READ_CHARS_DEFAULT = 8000;
const GREP_LIMIT_DEFAULT = 20;

export const ASK_SEARCH_TOOLS: ToolSchema[] = [
  {
    name: "list",
    description:
      "List Markdown note paths in the vault. Optional prefix filters to paths starting with that folder prefix (vault-relative POSIX paths).",
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
      "Search the indexed vault for relevant note chunks (hybrid dense+keyword when available, else keyword). Returns ranked snippets with file, line, and heading.",
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
      "Substring search over indexed chunk text (case-insensitive). Use to locate exact phrases; optional path limits to one note.",
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
    description: "Read the full current contents of a Markdown note. Use after find/grep to read surrounding context.",
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
      "Record a UI open target for a note (path, optional line or heading). Call when you cite a specific location the user should jump to.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative path" },
        line: { type: "integer", description: "1-based line number in the note" },
        heading: { type: "string", description: "Heading text to scroll to when line is unknown" },
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

function indexedFiles(index: Index, scope?: readonly string[]): string[] {
  const files = index.listFiles(scope);
  return [...files].sort((a, b) => a.localeCompare(b));
}

function mergeSource(state: AskSearchToolState, hit: SearchHit): void {
  const key = `${hit.file}:${hit.line}:${hit.heading}`;
  if (state.sources.some((s) => `${s.file}:${s.line}:${s.heading}` === key)) return;
  state.sources.push(hit);
}

function snippet(text: string, max = 160): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
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
    const prefix = asString(args.prefix)?.trim() ?? "";
    let paths: string[];
    if (ctx.listNotes) {
      paths = await ctx.listNotes(prefix || undefined);
    } else {
      paths = indexedFiles(ctx.index, ctx.scope);
      if (prefix) {
        const norm = normalizePath(prefix);
        paths = paths.filter((p) => p === norm || p.startsWith(`${norm}/`));
      }
    }
    paths = paths.filter((p) => /\.(md|markdown)$/i.test(p));
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
    const results = hits.map((h, i) => ({
      ref: state.sources.length - hits.length + i + 1,
      file: h.file,
      line: h.line,
      heading: h.heading || undefined,
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
    for (const m of matches) {
      mergeSource(state, {
        file: m.file,
        line: m.line,
        heading: m.heading,
        score: NaN,
        cosine: NaN,
        snippet: snippet(m.text),
        text: m.text,
        arms: "grep",
      });
    }
    return JSON.stringify({
      matches: matches.map((m) => ({
        file: m.file,
        line: m.line,
        heading: m.heading || undefined,
        snippet: snippet(m.text),
      })),
      count: matches.length,
    });
  }

  if (name === "read") {
    const path = asString(args.path);
    if (!path) return "ERROR: read requires a string 'path'.";
    const norm = normalizePath(path);
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
