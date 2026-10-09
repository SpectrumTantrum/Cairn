// Map agentic Ask (`runAskAgent`) metadata to citation chips + heading/line navigation.
// Pure helpers (no React) — unit-tested under node --test.
//
// A whole-file `read()` is stored at line 1 with a snippet of the file start. The cited
// fact is often later in that text. Locate the answer's passage in the file and point
// the chip at the enclosing heading (or the matched line) so the tooltip and the click
// target are the same line. A read that still cannot be matched is labeled "file"
// (line FILE_CITE_LINE) and dropped when the same note already has a resolved chip.
//
// The chip row only keeps notes the final answer cites or matches. A cite is an
// `open` anchor or an inline `[path:line]`. A match is the 4-word passage overlap
// below. Search, grep, and read hits that fail both are omitted. A single grep hit
// already located past line 1 still shows when the answer cites or matches nothing,
// so #66's Section B chip stays on that line. The 4-word threshold is unchanged.

import type { AskAgentResult, SearchHit } from "@cairn/engine";
import { FILE_CITE_LINE } from "./cite-format.js";

/** Answer prose split around inline `[path:line]` cites. */
export type InlineAnswerSegment = { kind: "text"; text: string } | { kind: "cite"; hit: SearchHit };

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
/** Unmatched whole-file read: no passage line to show. Heading-bearing chips stay. */
function asUnresolvedWholeFile(hit: SearchHit): SearchHit {
  if (hit.heading?.trim()) return hit;
  return { ...hit, line: FILE_CITE_LINE };
}

function retargetWholeFileRead(hit: SearchHit, answer: string, sources: SearchHit[]): SearchHit {
  if (hit.arms !== "read") return hit;
  const content = readBody(hit, sources);
  if (!content.trim() || !answer.trim()) return asUnresolvedWholeFile(hit);
  const located = locateCitedPassage(answer, content);
  if (!located) return asUnresolvedWholeFile(hit);
  return {
    ...hit,
    line: located.line,
    heading: located.heading,
    snippet: located.snippet,
  };
}

function vaultFileKey(file: string): string {
  return normVaultPath(file);
}

function citationRank(hit: SearchHit): number {
  if (hit.heading?.trim() && hit.line > 1) return 4;
  if (hit.line > 1) return 3;
  if (hit.heading?.trim() && hit.line > 0) return 2;
  if (hit.line > 0) return 1;
  return 0;
}

/** True when `next` is a better open target than `prev` for the same note. */
export function citationBeats(next: SearchHit, prev: SearchHit): boolean {
  return citationRank(next) > citationRank(prev);
}

function normalizeSnippet(snippet: string): string {
  return snippet.replace(/\s+/g, " ").trim();
}

/**
 * A chip that is only the top of the file: line 1 with no heading, the file sentinel,
 * or the same file-start snippet copied onto the model's line number.
 */
function isWholeFileShadow(hit: SearchHit, topSnippets: ReadonlySet<string>): boolean {
  if (hit.line > 1 && hit.heading?.trim()) return false;
  if (hit.line <= 1 && !hit.heading?.trim()) return true;
  if (hit.line <= 0) return true;
  const snippet = normalizeSnippet(hit.snippet);
  if (!snippet) return !hit.heading?.trim();
  return topSnippets.has(snippet);
}

/**
 * Per file, a passage or heading chip beats an unmatched / line-1 / file-start chip.
 * Distinct heading hits (Section 1 and Section 2) both stay. Leftover whole-file
 * reads collapse to one chip labeled "file".
 */
function dropUnresolvedWholeFileShadows(hits: SearchHit[]): SearchHit[] {
  const groups = new Map<string, SearchHit[]>();
  const order: string[] = [];
  for (const hit of hits) {
    const key = vaultFileKey(hit.file);
    const group = groups.get(key);
    if (group) group.push(hit);
    else {
      groups.set(key, [hit]);
      order.push(key);
    }
  }

  const kept: SearchHit[] = [];
  for (const key of order) {
    const group = groups.get(key) ?? [];
    const topSnippets = new Set(
      group
        .filter((hit) => hit.line <= 1)
        .map((hit) => normalizeSnippet(hit.snippet))
        .filter((snippet) => snippet.length > 0),
    );
    const hasSpecific = group.some((hit) => hit.line > 1 && !isWholeFileShadow(hit, topSnippets));
    if (!hasSpecific) {
      kept.push(collapseWholeFile(group));
      continue;
    }
    const seen = new Set<string>();
    for (const hit of group) {
      if (isWholeFileShadow(hit, topSnippets)) continue;
      const id = sourceKey(hit);
      if (seen.has(id)) continue;
      seen.add(id);
      kept.push(hit);
    }
  }
  return kept;
}

/** One chip for a note that never resolved past the top of the file. Reads say "file". */
function collapseWholeFile(group: SearchHit[]): SearchHit {
  const preferred = group.find((hit) => hit.arms === "read" || hit.line <= 0) ?? group[0];
  if (preferred.heading?.trim()) return preferred;
  if (preferred.arms === "read" || preferred.line <= 0) {
    return { ...preferred, line: FILE_CITE_LINE };
  }
  return preferred;
}

function corpusForFile(file: string, hits: readonly SearchHit[]): string {
  const key = vaultFileKey(file);
  const parts: string[] = [];
  for (const hit of hits) {
    if (vaultFileKey(hit.file) !== key) continue;
    if (hit.text) parts.push(hit.text);
    if (hit.snippet) parts.push(hit.snippet);
  }
  return parts.join("\n");
}

/** Files named by inline `[path:line]` cites in the answer. */
function filesCitedInAnswer(answer: string, hits: readonly SearchHit[]): Set<string> {
  const keys = new Set<string>();
  const re = new RegExp(INLINE_PATH_CITE.source, "g");
  for (const match of answer.matchAll(re)) {
    const raw = match[1] ?? "";
    if (!isInlineCitePath(raw)) continue;
    const matched = hitsForInlinePath(hits, raw);
    if (matched.length > 0) {
      for (const hit of matched) keys.add(vaultFileKey(hit.file));
    } else {
      keys.add(normVaultPath(raw));
    }
  }
  return keys;
}

/**
 * Notes the answer cites (`open` or `[path:line]`) or matches via the 4-word
 * passage overlap. Distinctive-token matching is intentionally not used.
 */
function filesAnswerUses(
  answer: string,
  opened: readonly { path: string }[],
  hits: readonly SearchHit[],
): Set<string> {
  const cited = filesCitedInAnswer(answer, hits);
  const used = new Set<string>();
  const seen = new Set<string>();
  for (const hit of hits) {
    const key = vaultFileKey(hit.file);
    if (seen.has(key)) continue;
    seen.add(key);
    if (opened.some((anchor) => vaultFileKey(anchor.path) === key) || cited.has(key)) {
      used.add(key);
      continue;
    }
    const corpus = corpusForFile(key, hits);
    if (corpus.trim() && longestSharedSpan(answer, corpus)) used.add(key);
  }
  return used;
}

/**
 * Drop tool hits the answer did not cite or match. When nothing was cited or
 * matched, one grep passage located past line 1 still remains (#66).
 */
function keepAnswerCitations(hits: SearchHit[], result: AskAgentResult): SearchHit[] {
  const used = filesAnswerUses(result.answer, result.opened, [...result.sources, ...hits]);
  const grepFiles = new Set<string>();
  for (const source of result.sources) {
    if (source.arms === "grep" && source.line > 1) grepFiles.add(vaultFileKey(source.file));
  }
  const onlyLocatedGrep = used.size === 0 && grepFiles.size === 1;
  return hits.filter((hit) => {
    const key = vaultFileKey(hit.file);
    if (used.has(key)) return true;
    return onlyLocatedGrep && grepFiles.has(key) && hit.line > 1;
  });
}

/**
 * Citations for the agentic Ask UI: prefer `opened[]` anchors (what the agent cited),
 * enriched from `sources`, then keep only notes the answer cites or matches.
 */
export function citationsFromAskAgent(result: AskAgentResult): SearchHit[] {
  const { sources, opened, answer } = result;
  const out: SearchHit[] = [];
  const seen = new Set<string>();

  for (const o of opened) {
    const match = pickSourceForOpen(sources, o.path, o.line, o.heading);
    // A heading hit already past line 1 is the location. Do not paint the model's
    // line (often 1 or a wrong inline cite) over it.
    const specificMatch = !!match && match.line > 1 && !!match.heading?.trim();
    const line = specificMatch ? match.line : (o.line ?? match?.line ?? 1);
    const heading = specificMatch ? match.heading : (o.heading ?? match?.heading ?? "");
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

  return keepAnswerCitations(dropUnresolvedWholeFileShadows(out), result);
}

const INLINE_PATH_CITE = /\[([^\[\]\n]+?):(\d+)\]/g;

/** `[path:line]` — a path has a slash or extension. Bracket numbers like `[1]` are prose. */
function isInlineCitePath(raw: string): boolean {
  const path = raw.trim();
  if (!path || /\s/.test(path)) return false;
  return path.includes(".") || path.includes("/") || path.includes("\\");
}

function normVaultPath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function pathBasename(path: string): string {
  const norm = normVaultPath(path);
  const slash = norm.lastIndexOf("/");
  return slash === -1 ? norm : norm.slice(slash + 1);
}

function hitsForInlinePath(sources: readonly SearchHit[], citedPath: string): SearchHit[] {
  const want = normVaultPath(citedPath);
  const full = sources.filter((s) => normVaultPath(s.file) === want);
  if (full.length > 0) return full;
  const base = pathBasename(citedPath);
  if (!base) return [];
  const byBase = sources.filter((s) => pathBasename(s.file) === base);
  const files = new Set(byBase.map((s) => normVaultPath(s.file)));
  return files.size === 1 ? byBase : [];
}

/** Ignore the bracket's line. A heading or passage chip beats a line-1 / file chip. */
function preferResolvedHit(hits: readonly SearchHit[]): SearchHit | undefined {
  if (hits.length === 0) return undefined;
  const headed = hits.find((h) => !!h.heading?.trim() && h.line > 1);
  if (headed) return headed;
  const later = hits.find((h) => h.line > 1);
  if (later) return later;
  const titled = hits.find((h) => !!h.heading?.trim() && h.line > 0);
  if (titled) return titled;
  return hits.find((h) => h.line > 0) ?? hits[0];
}

function pushText(segments: InlineAnswerSegment[], text: string): void {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last?.kind === "text") last.text += text;
  else segments.push({ kind: "text", text });
}

/**
 * Turn `[path:line]` markers into citation chips for a source the agent actually cited.
 * The bracket's line is not trusted — the chip is the already-resolved hit for that file.
 * Markers that match no cited source are removed, and the gap collapses to one space.
 * `[1]`-style bracket numbers are left as prose.
 */
export function splitInlineCites(answer: string, sources: readonly SearchHit[]): InlineAnswerSegment[] {
  const segments: InlineAnswerSegment[] = [];
  const re = new RegExp(INLINE_PATH_CITE.source, "g");
  let cursor = 0;
  let trimLeading = false;

  for (const match of answer.matchAll(re)) {
    const index = match.index ?? 0;
    const rawPath = match[1] ?? "";
    if (!isInlineCitePath(rawPath)) continue;
    const token = match[0];
    let before = answer.slice(cursor, index);
    if (trimLeading) {
      before = before.replace(/^[ \t]+/, "");
      trimLeading = false;
    }
    const hit = preferResolvedHit(hitsForInlinePath(sources, rawPath));
    if (hit) {
      pushText(segments, before);
      segments.push({ kind: "cite", hit });
    } else {
      const after = answer.slice(index + token.length);
      const beforeSpace = /[ \t]$/.test(before);
      const afterSpace = /^[ \t]/.test(after);
      if (beforeSpace && afterSpace) {
        before = before.replace(/[ \t]+$/, " ");
        trimLeading = true;
      } else if (beforeSpace && !afterSpace) {
        before = before.replace(/[ \t]+$/, "");
      } else if (!beforeSpace && afterSpace && before.length === 0 && segments.length === 0) {
        trimLeading = true;
      }
      pushText(segments, before);
    }
    cursor = index + token.length;
  }

  let rest = answer.slice(cursor);
  if (trimLeading) rest = rest.replace(/^[ \t]+/, "");
  pushText(segments, rest);
  return segments;
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

function collapsedLine(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/** 1-based line in `text` that contains the snippet, if any. */
function lineMatchingSnippet(text: string, snippet: string): number | null {
  const want = collapsedLine(snippet).replace(/…$/, "").trim();
  if (want.length < 8) return null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = collapsedLine(lines[i] ?? "");
    if (!line) continue;
    if (line.includes(want) || want.includes(line)) return i + 1;
  }
  return null;
}

/**
 * File line a citation click opens, from the hit alone.
 * When the hit text contains the heading, that heading line wins over a later
 * matched fact line so the tooltip matches `resolveCitationLine` on the note.
 * A file sentinel (line <= 0) is unchanged — the chip still says "file".
 */
export function citationLandingLine(
  hit: Pick<SearchHit, "line" | "heading" | "text" | "snippet">,
): number {
  if (hit.line <= 0) return hit.line;
  if (!hit.heading?.trim()) return hit.line;
  const text = hit.text ?? "";
  const headingAt = text ? lineForMarkdownHeading(text, hit.heading) : null;
  if (headingAt === null) return hit.line;

  const lineCount = text.split(/\r?\n/).length;
  const snippetAt = lineMatchingSnippet(text, hit.snippet ?? "");
  // Whole note, or a chunk that starts at file line 1: the stored line is the
  // heading or the matched fact inside this text.
  if (hit.line <= lineCount && (hit.line === headingAt || hit.line === snippetAt)) {
    return resolveCitationLine(text, hit);
  }
  // A later chunk: the stored line is the match, past line 1 of the file.
  if (snippetAt !== null && hit.line > lineCount) {
    const start = hit.line - snippetAt + 1;
    if (start > 1) return resolveCitationLine(`${"\n".repeat(start - 1)}${text}`, hit);
  }
  return hit.line;
}
