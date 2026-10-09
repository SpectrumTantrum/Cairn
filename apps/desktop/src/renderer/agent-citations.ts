// Map agentic Ask (`runAskAgent`) metadata to citation chips + heading/line navigation.
// Pure helpers (no React) — unit-tested under node --test.
//
// A whole-file `read()` is stored at line 1 with a snippet of the file start. The cited
// fact is often later in that text. Locate the answer's passage in the file and point
// the chip at the enclosing heading (or the matched line) so the tooltip and the click
// target are the same line.

import type { AskAgentResult, SearchHit } from "@cairn/engine";

/** Shared-word run long enough to be a passage, not a heading title or a short overlap. */
const MIN_PASSAGE_WORDS = 4;
const SNIPPET_MAX = 160;

function sourceKey(hit: Pick<SearchHit, "file" | "line" | "heading">): string {
  return `${hit.file}:${hit.line}:${hit.heading ?? ""}`;
}

function pickSourceForOpen(
  sources: SearchHit[],
  path: string,
  line?: number,
  heading?: string,
): SearchHit | undefined {
  const sameFile = (s: SearchHit) => s.file === path;
  if (heading?.trim()) {
    const withHeading = sources.find((s) => sameFile(s) && s.heading === heading);
    if (withHeading) return withHeading;
    // Heading-only open anchors must not inherit read()/open() stubs at line 1.
    if (line === undefined || line <= 0) return undefined;
  }
  if (line !== undefined && line > 0) {
    const atLine = sources.find((s) => sameFile(s) && s.line === line);
    if (atLine) return atLine;
  }
  return sources.find(sameFile);
}

function displaySnippet(hit: SearchHit): string {
  if (hit.snippet?.trim()) return hit.snippet;
  if (hit.text?.trim()) {
    const t = hit.text.trim();
    return t.length > 160 ? `${t.slice(0, 157)}…` : t;
  }
  return "";
}

function clipSnippet(raw: string): string {
  const t = raw.replace(/\s+/g, " ").trim();
  if (t.length <= SNIPPET_MAX) return t;
  return `${t.slice(0, SNIPPET_MAX - 1)}…`;
}

interface WordSpan {
  word: string;
  start: number;
  end: number;
}

function wordSpans(text: string): WordSpan[] {
  const re = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
  const out: WordSpan[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ word: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Longest contiguous word run shared by the answer and the file (quotes included). */
function longestSharedSpan(answer: string, content: string): { start: number; end: number } | null {
  const a = wordSpans(answer);
  const c = wordSpans(content);
  if (a.length < MIN_PASSAGE_WORDS || c.length < MIN_PASSAGE_WORDS) return null;
  let bestLen = 0;
  let bestEnd = -1;
  let prev = new Array<number>(c.length).fill(0);
  let curr = new Array<number>(c.length).fill(0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < c.length; j++) {
      const len = a[i].word === c[j].word ? (j > 0 ? prev[j - 1] : 0) + 1 : 0;
      curr[j] = len;
      if (len > bestLen) {
        bestLen = len;
        bestEnd = j;
      }
    }
    const swap = prev;
    prev = curr;
    curr = swap;
    curr.fill(0);
  }
  if (bestLen < MIN_PASSAGE_WORDS || bestEnd < 0) return null;
  const startSpan = c[bestEnd - bestLen + 1];
  return { start: startSpan.start, end: c[bestEnd].end };
}

function lineAt(content: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, content.length));
  let line = 1;
  for (let i = 0; i < clamped; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

function normalizeHeadingTitle(raw: string): string {
  return raw
    .trim()
    .replace(/\s+#+\s*$/, "")
    .trim()
    .toLowerCase();
}

function atxTitle(line: string): string | null {
  const m = /^(#{1,6})\s+(.+)$/.exec(line.trimEnd());
  if (!m) return null;
  const title = m[2].replace(/\s+#+\s*$/, "").trim();
  return title.length > 0 ? title : null;
}

/** Nearest ATX heading at or above `matchLine` (1-based). */
function enclosingHeading(content: string, matchLine: number): { title: string; line: number } | null {
  const lines = content.split(/\r?\n/);
  let found: { title: string; line: number } | null = null;
  for (let i = 0; i < lines.length && i + 1 <= matchLine; i++) {
    const title = atxTitle(lines[i]);
    if (title) found = { title, line: i + 1 };
  }
  return found;
}

/**
 * Find the cited fact inside a note the agent read in full.
 * Line is the enclosing heading when one exists, otherwise the matched line.
 * Null when the answer shares no distinctive passage with the file.
 */
function locateCitedPassage(
  answer: string,
  content: string,
): { line: number; heading: string; snippet: string } | null {
  const span = longestSharedSpan(answer, content);
  if (!span) return null;
  const matchLine = lineAt(content, span.start);
  const heading = enclosingHeading(content, matchLine);
  return {
    line: heading?.line ?? matchLine,
    heading: heading?.title ?? "",
    snippet: clipSnippet(content.slice(span.start, span.end)),
  };
}

function readBody(hit: SearchHit, sources: SearchHit[]): string {
  const bodies = [
    hit.arms === "read" ? hit.text : "",
    ...sources.filter((s) => s.file === hit.file && s.arms === "read").map((s) => s.text),
  ];
  let best = "";
  for (const raw of bodies) {
    const text = raw.replace(/\n…\(truncated at \d+ chars\)$/, "");
    if (text.length > best.length) best = text;
  }
  return best;
}

/**
 * `read()` records the top of the file. When the answer restates a later passage,
 * move that chip to the passage's heading line and show the passage as the snippet.
 * Find/grep/open hits are left alone so a real heading search still wins.
 */
function retargetWholeFileRead(hit: SearchHit, answer: string, sources: SearchHit[]): SearchHit {
  if (hit.arms !== "read") return hit;
  const content = readBody(hit, sources);
  if (!content.trim() || !answer.trim()) return hit;
  const located = locateCitedPassage(answer, content);
  if (!located) return hit;
  return {
    ...hit,
    line: located.line,
    heading: located.heading,
    snippet: located.snippet,
  };
}

/**
 * Citations for the agentic Ask UI: prefer `opened[]` anchors (what the agent cited),
 * enriched from `sources`, then append any remaining tool-gathered sources.
 */
export function citationsFromAskAgent(result: AskAgentResult): SearchHit[] {
  const { sources, opened, answer } = result;
  const out: SearchHit[] = [];
  const seen = new Set<string>();

  for (const o of opened) {
    const match = pickSourceForOpen(sources, o.path, o.line, o.heading);
    const line = o.line ?? match?.line ?? 1;
    const heading = o.heading ?? match?.heading ?? "";
    const base: SearchHit = match ?? {
      file: o.path,
      line,
      heading,
      score: NaN,
      cosine: NaN,
      snippet: "",
      text: "",
      arms: "open",
    };
    const hit = retargetWholeFileRead(
      {
        ...base,
        file: o.path,
        line: line > 0 ? line : 1,
        heading,
        snippet: displaySnippet(base),
      },
      answer,
      sources,
    );
    const key = sourceKey(hit);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }

  for (const s of sources) {
    if (s.arms === "open" && !s.snippet && !s.text && opened.some((o) => o.path === s.file)) {
      continue;
    }
    const hit = retargetWholeFileRead({ ...s, snippet: displaySnippet(s) }, answer, sources);
    const key = sourceKey(hit);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }

  return out;
}

/** 1-based line of a Markdown ATX heading (exact title match, case-insensitive). */
export function lineForMarkdownHeading(content: string, heading: string): number | null {
  const target = normalizeHeadingTitle(heading);
  if (!target) return null;
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const title = atxTitle(lines[i]);
    if (title && normalizeHeadingTitle(title) === target) return i + 1;
  }
  return null;
}

/** Prefer heading anchor when present; otherwise use the hit's line. */
export function resolveCitationLine(content: string, hit: Pick<SearchHit, "line" | "heading">): number {
  if (hit.heading?.trim()) {
    const fromHeading = lineForMarkdownHeading(content, hit.heading);
    if (fromHeading !== null) return fromHeading;
  }
  return hit.line > 0 ? hit.line : 1;
}
