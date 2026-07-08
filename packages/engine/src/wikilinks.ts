// Wikilink parsing, resolution, and backlinks (ADR-0003: the heterogeneous graph is a
// derived view over `[[wikilinks]]` in the vault's plain files, not a separate store).
//
// Pure functions only — no Index/DB/DOM. Resolution and backlinks operate over an
// explicit list of vault-relative paths / documents, because the persistence `Index`
// seam does not enumerate files or whole-file contents; the caller (e.g. VaultSession)
// supplies the vault's files. This keeps the graph a *derived view* the caller can
// rebuild on demand, exactly as ADR-0003 requires.
//
// ADR-0003 does not pin a link-resolution algorithm, so we use Obsidian's — the vault is
// Obsidian-compatible by invariant (CONTEXT.md): exact path match > unique basename
// match > unresolved (with the ambiguity candidates surfaced). Typed/link forms like
// `[[pdf: name · p.N]]` are parsed generically (no per-format branching) — the whole
// left-hand side is the target; resolution then treats it as any other name.

/** One parsed `[[wikilink]]` occurrence. */
export interface WikiLink {
  /** The full matched token, e.g. `[[foo|Foo]]`. */
  raw: string;
  /** Link target as written (left of `|`), trimmed; `#heading` / `^block` refs stripped. */
  target: string;
  /** Display alias (right of `|`), when present. */
  alias?: string;
  /** What a renderer shows: alias when present, else target. */
  display: string;
  /** Heading/block fragment after `#` or `^`, when present (without the sigil). */
  fragment?: string;
  /** 0-based character offset of `raw` within the source string. */
  offset: number;
}

/** Outcome of resolving a target against a set of vault paths. */
export interface WikiResolveResult {
  /** The resolved vault-relative path, or null when unresolved/ambiguous. */
  path: string | null;
  /** Candidate paths when the target is ambiguous (>1 basename match); else empty. */
  ambiguous: string[];
}

/** A vault file with its raw Markdown, for backlink computation. */
export interface VaultDoc {
  /** Vault-relative path, e.g. `notes/foo.md`. */
  path: string;
  content: string;
}

/** A single backlink: the source file and the specific link that points at the target. */
export interface Backlink {
  from: string;
  link: WikiLink;
}

const WIKILINK_RE = /\[\[([^\]]+?)\]\]/g;

/** Parse every `[[wikilink]]` / `[[target|alias]]` in a Markdown string, in order. */
export function parseWikilinks(markdown: string): WikiLink[] {
  const out: WikiLink[] = [];
  for (const m of markdown.matchAll(WIKILINK_RE)) {
    const inner = m[1];
    const pipe = inner.indexOf("|");
    const rawTarget = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
    const alias = pipe === -1 ? undefined : inner.slice(pipe + 1).trim() || undefined;
    if (!rawTarget) continue;

    // Split off an Obsidian heading (`#`) or block (`^`) fragment from the target.
    const fragMatch = rawTarget.match(/[#^]/);
    let target = rawTarget;
    let fragment: string | undefined;
    if (fragMatch && fragMatch.index !== undefined && fragMatch.index > 0) {
      target = rawTarget.slice(0, fragMatch.index).trim();
      fragment = rawTarget.slice(fragMatch.index + 1).trim() || undefined;
    }

    out.push({
      raw: m[0],
      target,
      alias,
      display: alias ?? rawTarget,
      fragment,
      offset: m.index ?? 0,
    });
  }
  return out;
}

function stripMdExt(p: string): string {
  return p.replace(/\.(md|markdown)$/i, "");
}

function basename(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const slash = norm.lastIndexOf("/");
  return slash === -1 ? norm : norm.slice(slash + 1);
}

/**
 * Resolve a link target to a vault-relative path using Obsidian-style rules:
 *   1. exact path match (with or without `.md`/`.markdown`), else
 *   2. unique basename match (target's leaf name matches exactly one file's leaf), else
 *   3. unresolved — `path: null`, with any basename candidates in `ambiguous`.
 * `files` are vault-relative paths; matching is case-sensitive on path, and the `.md`
 * extension is optional on the target (Obsidian omits it).
 */
export function resolveWikilink(target: string, files: string[]): WikiResolveResult {
  const wanted = stripMdExt(target.replace(/\\/g, "/").trim());
  if (!wanted) return { path: null, ambiguous: [] };

  // 1. Exact path match (extension optional on the target).
  for (const f of files) {
    if (stripMdExt(f.replace(/\\/g, "/")) === wanted) return { path: f, ambiguous: [] };
  }

  // 2. Unique basename match — only when the target is a bare name (no path separator).
  if (!wanted.includes("/")) {
    const wantedBase = stripMdExt(basename(wanted));
    const matches = files.filter((f) => stripMdExt(basename(f)) === wantedBase);
    if (matches.length === 1) return { path: matches[0], ambiguous: [] };
    if (matches.length > 1) return { path: null, ambiguous: matches };
  }

  return { path: null, ambiguous: [] };
}

/**
 * Backlinks for one target file: every doc containing a `[[wikilink]]` that resolves to
 * `targetPath`. `targetPath` should be a vault-relative path present in `docs`. A file is
 * not counted as its own backlink.
 */
export function computeBacklinks(targetPath: string, docs: VaultDoc[]): Backlink[] {
  const files = docs.map((d) => d.path);
  const targetNorm = stripMdExt(targetPath.replace(/\\/g, "/"));
  const out: Backlink[] = [];
  for (const doc of docs) {
    if (stripMdExt(doc.path.replace(/\\/g, "/")) === targetNorm) continue;
    for (const link of parseWikilinks(doc.content)) {
      const resolved = resolveWikilink(link.target, files).path;
      if (resolved && stripMdExt(resolved.replace(/\\/g, "/")) === targetNorm) {
        out.push({ from: doc.path, link });
      }
    }
  }
  return out;
}

/**
 * Build the full backlink map for a vault in one pass: `path -> Backlink[]`. Every doc in
 * `docs` gets an entry (empty array when nothing links to it), so callers can render the
 * left-rail backlinks view (ADR-0010) without probing per file.
 */
export function buildBacklinkIndex(docs: VaultDoc[]): Map<string, Backlink[]> {
  const files = docs.map((d) => d.path);
  const map = new Map<string, Backlink[]>();
  for (const d of docs) map.set(d.path, []);
  for (const doc of docs) {
    for (const link of parseWikilinks(doc.content)) {
      const resolved = resolveWikilink(link.target, files).path;
      if (!resolved || resolved === doc.path) continue;
      const bucket = map.get(resolved);
      if (bucket) bucket.push({ from: doc.path, link });
    }
  }
  return map;
}
