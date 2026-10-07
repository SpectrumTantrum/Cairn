// Map agentic Ask (`runAskAgent`) metadata to citation chips + heading/line navigation.
// Pure helpers (no React) — unit-tested under node --test.

import type { AskAgentResult, SearchHit } from "@cairn/engine";

function sourceKey(hit: Pick<SearchHit, "file" | "line" | "heading">): string {
  return `${hit.file}:${hit.line}:${hit.heading ?? ""}`;
}

function pickSourceForOpen(
  sources: SearchHit[],
  path: string,
  line?: number,
  heading?: string,
): SearchHit | undefined {
  const withHeading =
    heading?.trim()
      ? sources.find((s) => s.file === path && s.heading === heading)
      : undefined;
  if (withHeading) return withHeading;
  if (line !== undefined && line > 0) {
    const atLine = sources.find((s) => s.file === path && s.line === line);
    if (atLine) return atLine;
  }
  return sources.find((s) => s.file === path);
}

function displaySnippet(hit: SearchHit): string {
  if (hit.snippet?.trim()) return hit.snippet;
  if (hit.text?.trim()) {
    const t = hit.text.trim();
    return t.length > 160 ? `${t.slice(0, 157)}…` : t;
  }
  return "";
}

/**
 * Citations for the agentic Ask UI: prefer `opened[]` anchors (what the agent cited),
 * enriched from `sources`, then append any remaining tool-gathered sources.
 */
export function citationsFromAskAgent(result: AskAgentResult): SearchHit[] {
  const { sources, opened } = result;
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
    const hit: SearchHit = {
      ...base,
      file: o.path,
      line: line > 0 ? line : 1,
      heading,
      snippet: displaySnippet(base),
    };
    const key = sourceKey(hit);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }

  for (const s of sources) {
    const key = sourceKey(s);
    if (seen.has(key)) continue;
    if (s.arms === "open" && !s.snippet && !s.text && opened.some((o) => o.path === s.file)) {
      continue;
    }
    seen.add(key);
    out.push({
      ...s,
      snippet: displaySnippet(s),
    });
  }

  return out;
}

/** 1-based line of a Markdown ATX heading (exact title match, case-insensitive). */
export function lineForMarkdownHeading(content: string, heading: string): number | null {
  const target = heading.trim().toLowerCase();
  if (!target) return null;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.+)$/.exec(lines[i]);
    if (m && m[2].trim().toLowerCase() === target) return i + 1;
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
