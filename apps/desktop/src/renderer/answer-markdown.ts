// Emphasis in a settled or streaming answer. Citation chips are split out first,
// so this only sees prose. `**` / `__` become bold and `*` / `_` become italic
// when the markers hug a non-empty span. `2 * 3` stays literal. Leftover `**`
// and `__` are removed so a chip wrapped in asterisks does not show them.

export type AnswerMarkdownRun = { kind: "text" | "strong" | "em"; text: string };

const BOLD_RE = /(\*\*|__)(\S(?:[\s\S]*?\S)?)\1/g;
const EM_RE = /(?<!\*)\*(?!\*)(\S(?:[\s\S]*?\S)?)\*(?!\*)|(?<!_)_(?!_)(\S(?:[\s\S]*?\S)?)_(?!_)/g;

function pushRun(out: AnswerMarkdownRun[], kind: AnswerMarkdownRun["kind"], text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === kind) last.text += text;
  else out.push({ kind, text });
}

function stripDanglingMarkers(text: string): string {
  return text.replace(/\*\*|__/g, "");
}

function parseEm(source: string): AnswerMarkdownRun[] {
  const out: AnswerMarkdownRun[] = [];
  let cursor = 0;
  for (const match of source.matchAll(EM_RE)) {
    const index = match.index ?? 0;
    pushRun(out, "text", stripDanglingMarkers(source.slice(cursor, index)));
    pushRun(out, "em", match[1] ?? match[2] ?? "");
    cursor = index + match[0].length;
  }
  pushRun(out, "text", stripDanglingMarkers(source.slice(cursor)));
  return out;
}

function parseBold(source: string): AnswerMarkdownRun[] {
  const out: AnswerMarkdownRun[] = [];
  let cursor = 0;
  for (const match of source.matchAll(BOLD_RE)) {
    const index = match.index ?? 0;
    out.push(...parseEm(source.slice(cursor, index)));
    const inner = parseEm(match[2] ?? "");
    for (const run of inner) {
      pushRun(out, run.kind === "text" ? "strong" : run.kind, run.text);
    }
    cursor = index + match[0].length;
  }
  out.push(...parseEm(source.slice(cursor)));
  return out;
}

/** Bold and italic runs for one prose segment. Markers are not left in the text. */
export function answerMarkdownRuns(source: string): AnswerMarkdownRun[] {
  return parseBold(source);
}
