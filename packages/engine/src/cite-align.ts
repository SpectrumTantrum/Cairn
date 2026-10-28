// Classic Ask sometimes copies a clock time out of the top passage and labels it
// with the next source number. On the F04 Lisbon rows, chunk 31 is prompt [1]
// and states 9:40; [2] is a different file and does not. The answer is right
// and the marker is not. Renumber the marker to a passage that contains the
// time. Answers with no clock time are unchanged, so this does not touch
// retrieval or the weak-band note.

export interface ClockCiteSource {
  file: string;
  text: string;
  heading?: string;
}

const CITE = /\[(\d+)\]/g;
const CLOCK = /(?<!\d)(\d{1,2}):(\d{2})(?!\d)/g;

/** Normalize clock times in `text` to `H:MM` (hour without a leading zero). */
export function clockTimes(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(CLOCK)) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) continue;
    const key = `${hour}:${match[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function corpus(source: ClockCiteSource): string {
  return source.heading ? `${source.heading}\n${source.text}` : source.text;
}

function covers(source: ClockCiteSource, times: readonly string[]): boolean {
  const have = new Set(clockTimes(corpus(source)));
  return times.every((time) => have.has(time));
}

/** Sentence (or line) that holds the marker, so a later time does not retarget an earlier claim. */
function claimWindow(answer: string, start: number, end: number): string {
  let from = 0;
  for (let i = start - 1; i >= 0; i--) {
    const ch = answer[i];
    if (ch !== "." && ch !== "!" && ch !== "?" && ch !== "\n") continue;
    const next = answer[i + 1];
    if (next !== undefined && !/\s/.test(next)) continue;
    from = i + 1;
    break;
  }
  let to = answer.length;
  for (let i = end; i < answer.length; i++) {
    const ch = answer[i];
    if (ch === "." || ch === "!" || ch === "?" || ch === "\n") {
      to = i + 1;
      break;
    }
  }
  return answer.slice(from, to);
}

function markerFor(
  answer: string,
  start: number,
  end: number,
  n: number,
  sources: readonly ClockCiteSource[],
): string {
  if (!Number.isInteger(n) || n < 1 || n > sources.length) return `[${n}]`;
  const times = clockTimes(claimWindow(answer, start, end));
  if (times.length === 0) return `[${n}]`;
  const cited = sources[n - 1];
  if (!cited || covers(cited, times)) return `[${n}]`;
  const sameFile = sources.findIndex((source) => source.file === cited.file && covers(source, times));
  if (sameFile >= 0) return `[${sameFile + 1}]`;
  const any = sources.findIndex((source) => covers(source, times));
  if (any >= 0) return `[${any + 1}]`;
  return `[${n}]`;
}

/**
 * Point each `[n]` at a shown passage that contains the claim's clock times.
 * The cited passage wins when it already contains them. Otherwise the earliest
 * passage of that same file wins, then the earliest passage of any file.
 */
export function alignClockCitations(answer: string, sources: readonly ClockCiteSource[]): string {
  if (!answer || sources.length === 0) return answer;
  let out = "";
  let cursor = 0;
  for (const match of answer.matchAll(CITE)) {
    const start = match.index ?? 0;
    const raw = match[0];
    const end = start + raw.length;
    out += answer.slice(cursor, start);
    out += markerFor(answer, start, end, Number(match[1]), sources);
    cursor = end;
  }
  out += answer.slice(cursor);
  return out;
}
