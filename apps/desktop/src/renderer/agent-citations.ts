// Map agentic Ask (`runAskAgent`) metadata to citation chips + heading/line navigation.
// Pure helpers (no React) — unit-tested under node --test.
//
// A whole-file `read()` is stored at line 1 with a snippet of the file start. The cited
// fact is often later in that text. Locate the answer's passage in the file and point
// the chip at the enclosing heading (or the matched line) so the tooltip and the click
// target are the same line. A read that still cannot be matched is labeled "file"
// (line FILE_CITE_LINE) and dropped when the same note already has a resolved chip.
//
// The chip row keeps notes the final answer cites or matches, and every file the
// agent read and answered from. A cite is an `open` anchor or an inline `[path:line]`.
// A match is the 4-word passage overlap below: the chip points at that heading line.
// A read that contains the answer but shares no 4-word run is labeled "file".
// It is not dropped. A find or grep hit the answer did not use is still omitted.
// One such hit is kept, at its own line and heading, when the answer shares a
// distinctive token from that hit and that file is not already cited.
// A single grep hit already located past line 1 still shows when nothing else was
// cited or matched, so #66's Section B chip stays on that line. The 4-word
// threshold is unchanged.
//
// A shared token is not a match of its own. The veto looks only at other files
// the agent read, not at search or grep hits. When the overlap's content words
// all appear in another read, and the answer's fact (a content word in that
// read) is absent here, this file gets no chip. An open or an inline cite does
// not keep that neighbor. Function words still count toward the 4-word run;
// they are not the fact.
//
// Each PDF page is its own location. A page the answer matches is cited as
// `file p.N`. A PDF that was read and matches no page is still cited, labeled "file".
// That file chip quotes the one read page that contains the answer. When no
// page does, or more than one page ties, the chip has no snippet. The title
// page is not a default.

import type { AskAgentResult, SearchHit } from "@cairn/engine";
import { FILE_CITE_LINE, isAudioPath, isImagePath, isPdfPath, isVideoPath } from "./cite-format.js";

/** Answer prose split around inline `[path:line]` cites. */
export type InlineAnswerSegment = { kind: "text"; text: string } | { kind: "cite"; hit: SearchHit };

/** Shared-word run long enough to be a passage, not a heading title or a short overlap. */
const MIN_PASSAGE_WORDS = 4;

/**
 * Function words. They still count inside a 4-word run ("is COPPER FINCH and").
 * They do not count as the fact that distinguishes one file from another, so a
 * shared codename plus these words cannot cite a file that lacks the answer's fact.
 */
const CLOSED_CLASS = new Set([
  "a", "an", "the", "and", "or", "but", "nor", "so", "if", "of", "to", "in", "on", "for",
  "with", "at", "by", "from", "as", "into", "over", "under", "is", "are", "was", "were",
  "be", "been", "being", "it", "its", "this", "that", "these", "those", "not", "no",
]);
const SNIPPET_MAX = 160;

function sourceKey(hit: Pick<SearchHit, "file" | "line" | "heading" | "page">): string {
  return `${hit.file}:${hit.line}:${hit.heading ?? ""}:${hit.page ?? ""}`;
}

function pickSourceForOpen(
  sources: SearchHit[],
  path: string,
  line?: number,
  heading?: string,
  page?: number,
): SearchHit | undefined {
  const sameFile = (s: SearchHit) => s.file === path;
  if (page !== undefined && page > 0) {
    const atPage = sources.find((s) => sameFile(s) && s.page === page);
    if (atPage) return atPage;
  }
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

function isContentWord(word: string): boolean {
  return !CLOSED_CLASS.has(word);
}

/** Content words from `answer` that occur in `text`, in answer order, once each. */
function answerContentIn(text: string, answer: string): string[] {
  const words = new Set(wordSpans(text).map((span) => span.word));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const span of wordSpans(answer)) {
    if (!isContentWord(span.word) || !words.has(span.word) || seen.has(span.word)) continue;
    seen.add(span.word);
    out.push(span.word);
  }
  return out;
}

/**
 * True when every answer content word in `corpus` also appears in another read,
 * and that other read holds an answer content word this file does not.
 * Search and grep hits are not reads and must not be passed in `others`.
 */
function suppressedByOtherRead(answer: string, corpus: string, others: readonly string[]): boolean {
  const rest = others.map((text) => text.trim()).filter((text) => text.length > 0);
  if (rest.length === 0) return false;
  const here = new Set(answerContentIn(corpus, answer));
  const elsewhere = new Set<string>();
  for (const text of rest) {
    for (const word of answerContentIn(text, answer)) elsewhere.add(word);
  }
  if ([...here].some((word) => !elsewhere.has(word))) return false;
  const fileWords = new Set(wordSpans(corpus).map((span) => span.word));
  return [...elsewhere].some((word) => !fileWords.has(word));
}

/**
 * The 4-word overlap cites `corpus` unless it is only a token shared with another
 * file the agent read and the answer's fact is in that other read, not here.
 */
function passageMatches(answer: string, corpus: string, others: readonly string[]): boolean {
  const span = longestSharedSpan(answer, corpus);
  if (!span) return false;
  const rest = others.map((text) => text.trim()).filter((text) => text.length > 0);
  if (rest.length === 0) return true;
  if (!suppressedByOtherRead(answer, corpus, rest)) return true;
  const spanContent = wordSpans(corpus.slice(span.start, span.end))
    .map((w) => w.word)
    .filter(isContentWord);
  const otherContent = new Set<string>();
  for (const text of rest) {
    for (const w of wordSpans(text)) {
      if (isContentWord(w.word)) otherContent.add(w.word);
    }
  }
  const sharedTokenOnly = spanContent.length === 0 || spanContent.every((word) => otherContent.has(word));
  return !sharedTokenOnly;
}

/**
 * This body was read, and another read holds the answer's fact while this one
 * only shares the codename. Search hits are not evidence. An empty body is not
 * a neighbor we can judge.
 */
function sharedTokenNeighbor(answer: string, corpus: string, others: readonly string[]): boolean {
  if (!corpus.trim()) return false;
  if (!suppressedByOtherRead(answer, corpus, others)) return false;
  return !passageMatches(answer, corpus, others);
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
  // A PDF page is already the location. Do not retarget it like a whole-note read,
  // and do not copy another page's passage onto this one.
  if (isPdfPath(hit.file)) return hit;
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
    // PDF pages are separate locations, all stored at line 1. Collapsing them
    // keeps the first page and drops the page the answer actually matches.
    if (group.length > 0 && group.every(isLocatedPdfPage)) {
      const seen = new Set<string>();
      for (const hit of group) {
        const id = sourceKey(hit);
        if (seen.has(id)) continue;
        seen.add(id);
        kept.push(hit);
      }
      continue;
    }
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

function isLocatedPdfPage(hit: Pick<SearchHit, "file" | "page">): boolean {
  return isPdfPath(hit.file) && (hit.page ?? 0) > 0;
}

/** Other touched pages and files. A PDF page is not evidence against itself. */
function otherCorpora(
  self: Pick<SearchHit, "file" | "page">,
  hits: readonly SearchHit[],
): string[] {
  const selfFile = vaultFileKey(self.file);
  const selfPage = self.page ?? 0;
  const buckets = new Map<string, string[]>();
  for (const hit of hits) {
    const file = vaultFileKey(hit.file);
    const page = hit.page ?? 0;
    const sameFile = file === selfFile;
    if (sameFile && (selfPage <= 0 || page <= 0 || page === selfPage)) continue;
    const part = `${hit.text ?? ""}\n${hit.snippet ?? ""}`.trim();
    if (!part) continue;
    const key = page > 0 ? `${file}#${page}` : file;
    const list = buckets.get(key);
    if (list) list.push(part);
    else buckets.set(key, [part]);
  }
  return [...buckets.values()].map((parts) => parts.join("\n"));
}

function readHits(hits: readonly SearchHit[]): SearchHit[] {
  return hits.filter((hit) => hit.arms === "read");
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
 * passage overlap. A shared codename is not enough when the fact is in another read.
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
    const corpus = corpusForFile(key, hits);
    const others = otherCorpora({ file: hit.file }, readHits(hits));
    const openedOrCited = opened.some((anchor) => vaultFileKey(anchor.path) === key) || cited.has(key);
    // An open or inline cite still has to hold the fact. A neighbor that only
    // shares the codename with another read does not become a chip.
    if (openedOrCited && !sharedTokenNeighbor(answer, corpus, others)) {
      used.add(key);
      continue;
    }
    if (corpus.trim() && passageMatches(answer, corpus, others)) used.add(key);
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
    if (isPdfPath(hit.file)) {
      const page = hit.page ?? 0;
      const body = (hit.text ?? "").trim() || (hit.snippet ?? "").trim();
      if (page <= 0 || !body) return false;
      const openedPage = result.opened.some(
        (anchor) => vaultFileKey(anchor.path) === vaultFileKey(hit.file) && anchor.page === page,
      );
      const corpus = `${hit.text ?? ""}\n${hit.snippet ?? ""}`;
      const others = otherCorpora(hit, readHits([...result.sources, ...hits]));
      if (openedPage && !sharedTokenNeighbor(result.answer, corpus, others)) return true;
      if (passageMatches(result.answer, corpus, others)) return true;
      return (
        onlyLocatedGrep &&
        grepFiles.has(vaultFileKey(hit.file)) &&
        hit.line > 1 &&
        !sharedTokenNeighbor(result.answer, corpus, others)
      );
    }
    const key = vaultFileKey(hit.file);
    if (used.has(key)) return true;
    const corpus = corpusForFile(key, [...result.sources, ...hits]);
    const others = otherCorpora(hit, readHits([...result.sources, ...hits]));
    return onlyLocatedGrep && grepFiles.has(key) && hit.line > 1 && !sharedTokenNeighbor(result.answer, corpus, others);
  });
}

function pageBody(page: SearchHit): string {
  return (page.text ?? "").trim() || (page.snippet ?? "").trim();
}

/**
 * The read page whose text contains the answer, when exactly one page does.
 * A tie, or no overlap, means the page cannot be determined.
 */
function pdfAnswerPage(answer: string, pages: readonly SearchHit[]): SearchHit | undefined {
  const scored = pages.map((page) => ({
    page,
    score: answerContentIn(`${page.text ?? ""}\n${page.snippet ?? ""}`, answer).length,
  }));
  const best = scored.reduce((max, item) => Math.max(max, item.score), 0);
  if (best === 0) return undefined;
  const winners = scored.filter((item) => item.score === best);
  return winners.length === 1 ? winners[0].page : undefined;
}

/** Interrogatives and other words that are not a retrieved fact. */
const EXTRA_STOP = new Set([
  "what", "how", "where", "when", "who", "which", "why",
  "your", "you", "our", "their", "there", "they", "them", "we",
  "can", "could", "would", "should", "have", "has", "had", "will",
  "just", "also", "than", "then", "too", "very",
  "notes", "note", "file", "files", "say", "says", "said", "does", "do", "did", "about",
]);

function isStopword(word: string): boolean {
  return CLOSED_CLASS.has(word) || EXTRA_STOP.has(word);
}

function askedWords(result: AskAgentResult): Set<string> {
  const question = (result as AskAgentResult & { question?: string }).question ?? "";
  return new Set(wordSpans(question).map((span) => span.word));
}

function isNumberOrCode(word: string): boolean {
  return /\d/.test(word) || /[-_]/.test(word);
}

function filesWithToken(word: string, sources: readonly SearchHit[]): Set<string> {
  const files = new Set<string>();
  for (const hit of sources) {
    const blob = `${hit.text ?? ""}\n${hit.snippet ?? ""}`;
    if (wordSpans(blob).some((span) => span.word === word)) files.add(vaultFileKey(hit.file));
  }
  return files;
}

/** A content word that shows up in exactly one retrieved file. */
function isRareWord(word: string, file: string, sources: readonly SearchHit[]): boolean {
  if (word.length < 4 || isStopword(word) || isNumberOrCode(word)) return false;
  const files = filesWithToken(word, sources);
  return files.size === 1 && files.has(vaultFileKey(file));
}

function isDistinctiveToken(
  word: string,
  file: string,
  sources: readonly SearchHit[],
  asked: ReadonlySet<string>,
): boolean {
  if (isStopword(word) || asked.has(word)) return false;
  return isNumberOrCode(word) || isRareWord(word, file, sources);
}

function isRetrievalHit(hit: SearchHit): boolean {
  return (
    hit.arms === "grep" ||
    hit.arms === "find" ||
    hit.arms === "fts" ||
    hit.arms === "dense" ||
    hit.arms === "dense+fts"
  );
}

/** The hit's own text shares a number, code, or rare word with the answer. */
function hitSharesDistinctive(
  answer: string,
  hit: SearchHit,
  sources: readonly SearchHit[],
  asked: ReadonlySet<string>,
): boolean {
  const answerWords = new Set(wordSpans(answer).map((span) => span.word));
  const blob = `${hit.text ?? ""}\n${hit.snippet ?? ""}`;
  for (const span of wordSpans(blob)) {
    if (!answerWords.has(span.word)) continue;
    if (isDistinctiveToken(span.word, hit.file, sources, asked)) return true;
  }
  return false;
}

/**
 * A file the agent read and answered from always yields a chip. A matched
 * passage is already in `kept`. What remains is labeled "file".
 * A PDF read is answered-from for this fallback unless another read holds the
 * answer's fact and this file does not. A note is answered-from when the
 * answer's content words occur in it. Another read that holds the answer's
 * fact suppresses a file whose overlap is only the shared token.
 * A PDF file chip quotes the unique read page that contains the answer, or
 * nothing when that page cannot be determined.
 * A find or grep hit that did not already match still yields its own line and
 * heading when the answer shares a distinctive token from that hit: a number,
 * a code or ID-like token, or a rare word. Stopwords and words from the
 * question do not count. A filename written only in the answer does not.
 * A file the read fallback already cited stays that chip.
 */
function citeAnsweredReads(kept: SearchHit[], result: AskAgentResult): SearchHit[] {
  const cited = new Set(kept.map((hit) => vaultFileKey(hit.file)));
  const out = [...kept];
  const reads = readHits(result.sources);
  const seen = new Set<string>();
  for (const source of reads) {
    const key = vaultFileKey(source.file);
    if (seen.has(key) || cited.has(key)) continue;
    seen.add(key);
    const pdf = isPdfPath(source.file);
    const corpus = corpusForFile(key, result.sources);
    const others = otherCorpora(pdf ? source : { file: source.file }, reads);
    if (suppressedByOtherRead(result.answer, corpus, others)) continue;
    if (!pdf && answerContentIn(corpus, result.answer).length === 0) continue;
    const fileHit: SearchHit = { ...source, line: FILE_CITE_LINE, heading: "" };
    delete fileHit.page;
    if (pdf) {
      const pages = reads.filter((hit) => vaultFileKey(hit.file) === key && (hit.page ?? 0) > 0);
      const chosen = pdfAnswerPage(result.answer, pages);
      const body = chosen ? pageBody(chosen) : "";
      fileHit.snippet = body ? clipSnippet(body) : "";
      fileHit.text = body;
    }
    out.push(fileHit);
    cited.add(key);
  }

  const asked = askedWords(result);
  const seenRetrieval = new Set<string>();
  for (const source of result.sources) {
    if (!isRetrievalHit(source)) continue;
    const key = vaultFileKey(source.file);
    if (seenRetrieval.has(key) || cited.has(key)) continue;
    seenRetrieval.add(key);
    const corpus = corpusForFile(key, result.sources);
    const others = otherCorpora({ file: source.file }, result.sources);
    if (suppressedByOtherRead(result.answer, corpus, others)) continue;
    const matched = result.sources.filter(
      (hit) => isRetrievalHit(hit) && vaultFileKey(hit.file) === key && hitSharesDistinctive(result.answer, hit, result.sources, asked),
    );
    if (matched.length === 0) continue;
    out.push(matched.find((hit) => hit.line > 1) ?? matched[0]);
    cited.add(key);
  }
  return out;
}

/** One chip per PDF page. The first hit (opened anchors are recorded first) wins. */
function collapsePdfPages(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const hit of hits) {
    if (!isPdfPath(hit.file) || !(hit.page && hit.page > 0)) {
      out.push(hit);
      continue;
    }
    const key = `${vaultFileKey(hit.file)}:${hit.page}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
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
    const match = pickSourceForOpen(sources, o.path, o.line, o.heading, o.page);
    // A heading hit already past line 1 is the location. Do not paint the model's
    // line (often 1 or a wrong inline cite) over it.
    const specificMatch = !!match && match.line > 1 && !!match.heading?.trim();
    const line = specificMatch ? match.line : (o.line ?? match?.line ?? 1);
    const heading = specificMatch ? match.heading : (o.heading ?? match?.heading ?? "");
    const page = o.page ?? match?.page;
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
        ...(page ? { page } : {}),
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

  const located = keepAnswerCitations(dropUnresolvedWholeFileShadows(out), result);
  return collapsePdfPages(citeAnsweredReads(located, result));
}

/**
 * Classic hits are `fts` / `dense`, not reads, so the agentic neighbor veto
 * never sees them. Drop a chip when another retrieved hit holds the answer's
 * fact and this one only shares the passage.
 */
function classicSharedNeighbor(answer: string, chip: SearchHit, sources: readonly SearchHit[]): boolean {
  return sharedTokenNeighbor(answer, corpusForFile(chip.file, sources), otherCorpora(chip, sources));
}

/** 1-based `[n]` markers in classic prose. `[path:line]` is not a marker. */
function citedMarkerIndexes(answer: string): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const match of answer.matchAll(/\[(\d+)\]/g)) {
    const n = Number(match[1]);
    if (!Number.isInteger(n) || n < 1 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/** Question tokens are removed from the fallback match. The prompt is unchanged. */
function answerWithoutQuestionTokens(answer: string, question: string): string {
  const asked = new Set(wordSpans(question).map((span) => span.word));
  if (asked.size === 0) return answer;
  return answer.replace(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu, (word) =>
    asked.has(word.toLowerCase()) ? " " : word,
  );
}

/**
 * Classic Ask chips for one turn.
 * When the answer cites `[n]`, those numbers are the chips — the retrieval
 * index the model was shown — and the token filter does not add the others.
 * With no markers, the agentic filter runs (no opened anchors, question
 * attached). Question tokens are removed first, so an echoed codename is not
 * a match. A neighbor that only shares a passage is dropped there too.
 * Each chip keeps the 1-based index it had in `sources`.
 * `lastSources` is that full list, for the Sources tab.
 */
export function classicAskTurn(
  answer: string,
  sources: SearchHit[],
  question: string,
): { chips: SearchHit[]; lastSources: SearchHit[] } {
  const indexed = sources.map((hit, i) => ({ ...hit, citeIndex: i + 1 }));
  const markers = citedMarkerIndexes(answer);
  if (markers.length > 0) {
    const wanted = new Set(markers);
    return {
      chips: indexed.filter((hit) => hit.citeIndex !== undefined && wanted.has(hit.citeIndex)),
      lastSources: sources,
    };
  }
  const judged = answerWithoutQuestionTokens(answer, question);
  const chips = citationsFromAskAgent(
    Object.assign(
      {
        answer: judged,
        sources: indexed,
        opened: [] as AskAgentResult["opened"],
        seedHits: [] as SearchHit[],
        steps: 0,
        trace: [],
        stopReason: "done" as const,
        grounded: true,
      },
      { question },
    ),
  ).filter((chip) => !classicSharedNeighbor(judged, chip, indexed));
  return { chips, lastSources: sources };
}

/** Classic chip badge: the retrieval number, so it matches prose `[n]`. */
export function classicChipBadge(hit: Pick<SearchHit, "citeIndex">, position: number): number {
  const n = hit.citeIndex;
  if (typeof n === "number" && Number.isFinite(n) && n >= 1) return Math.floor(n);
  return position;
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

/**
 * Where a citation chip click opens. The editor line is the number on the
 * chip (`citationLandingLine`). A `file` chip (line <= 0) opens at line 1
 * with no highlight. PDF and media stay on their own viewers.
 */
export type CitationOpenTarget =
  | { kind: "pdf"; page: number }
  | { kind: "image" }
  | { kind: "audio" }
  | { kind: "video" }
  | { kind: "editor"; line: number; highlight: boolean };

export function citationOpenTarget(
  hit: Pick<SearchHit, "file" | "line" | "heading" | "text" | "snippet" | "page">,
): CitationOpenTarget {
  if (isPdfPath(hit.file)) return { kind: "pdf", page: hit.page && hit.page > 0 ? hit.page : 1 };
  if (isImagePath(hit.file)) return { kind: "image" };
  if (isAudioPath(hit.file)) return { kind: "audio" };
  if (isVideoPath(hit.file)) return { kind: "video" };
  const landing = citationLandingLine(hit);
  if (landing > 0) return { kind: "editor", line: landing, highlight: true };
  return { kind: "editor", line: 1, highlight: false };
}

/** 1-based editor line clamped into the open buffer. Past-the-end lands on the last line. */
export function clampCitationLine(line: number, docLines: number): number {
  const last = Number.isFinite(docLines) && docLines >= 1 ? Math.floor(docLines) : 1;
  if (!Number.isFinite(line) || line < 1) return 1;
  return Math.min(Math.floor(line), last);
}
