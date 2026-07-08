// Dependency-free line diff for agent-edit previews (ADR-0008 diff-hunk cards).
// The model proposes full new file content (never a patch — see agent-run.ts for
// why that is more reliable on small local models); WE derive the diff so the
// preview is deterministic and never trusts model-emitted line numbers.

/** One line in a rendered diff: unchanged context, an addition, or a removal. */
export interface DiffLine {
  type: "context" | "add" | "remove";
  text: string;
}

/** A rendered edit preview: the per-line diff plus added/removed counts. */
export interface DiffPreview {
  lines: DiffLine[];
  added: number;
  removed: number;
}

function splitLines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split("\n");
  // A trailing newline yields a final empty element; drop it so "a\n" is one line.
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/**
 * Line-level diff of `before` → `after` via a longest-common-subsequence walk.
 * O(n·m) — fine for single-note previews (notes are small). Returns removals for
 * lines only in `before`, additions for lines only in `after`, context otherwise.
 */
export function diffLines(before: string, after: string): DiffPreview {
  const a = splitLines(before);
  const b = splitLines(after);
  const n = a.length;
  const m = b.length;

  // LCS length table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ type: "context", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      lines.push({ type: "remove", text: a[i] });
      removed++;
      i++;
    } else {
      lines.push({ type: "add", text: b[j] });
      added++;
      j++;
    }
  }
  while (i < n) {
    lines.push({ type: "remove", text: a[i++] });
    removed++;
  }
  while (j < m) {
    lines.push({ type: "add", text: b[j++] });
    added++;
  }
  return { lines, added, removed };
}
