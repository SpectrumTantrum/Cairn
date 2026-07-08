// The disposable Index under <vault>/.cairn/index.db (CONTEXT.md): chunks + FTS5 keyword
// index + (when hybrid) sqlite-vec dense table + content-addressed embedding cache.
// Schema is the G5 subset; ports shapes proven in spikes/hybrid-sqlite.

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface ChunkRow {
  id: number;
  file: string;
  ordinal: number;
  line: number;
  heading: string;
  text: string;
}

export interface DenseHit {
  id: number;
  distance: number;
  cosine: number;
}

export interface RebuildChunkInput {
  id: number;
  file: string;
  ordinal: number;
  line: number;
  heading: string;
  text: string;
  hash: string;
  vector?: Buffer | null;
}

export interface RebuildIndexInput {
  mode: "hybrid" | "lexical";
  embedder?: string;
  dim?: number;
  files: number;
  chunks: RebuildChunkInput[];
}

/** Persistence seam for the vault's derived Index (chunks, vectors, FTS, embed cache, meta). */
export interface Index {
  readonly vaultRoot: string;
  readonly dir: string;

  getMeta(key: string): string | undefined;
  hasVectors(): boolean;

  getCachedVec(hash: string, embedder: string, dim: number): Buffer | undefined;
  putCachedVec(hash: string, embedder: string, dim: number, vec: Buffer): void;
  rebuildIndex(input: RebuildIndexInput): void;

  getChunk(id: number): ChunkRow | undefined;
  denseArm(qvec: Buffer, pool: number): DenseHit[];
  ftsArm(match: string, pool: number): { id: number; rank: number }[];

  close(): void;
}

export function openIndex(vaultRoot: string): SqliteIndex {
  return new SqliteIndex(vaultRoot);
}

export class SqliteIndex implements Index {
  private readonly db: Database.Database;
  readonly dir: string;
  readonly vaultRoot: string;

  constructor(vaultRoot: string) {
    this.vaultRoot = vaultRoot;
    this.dir = join(vaultRoot, ".cairn");
    mkdirSync(this.dir, { recursive: true });
    this.db = new Database(join(this.dir, "index.db"));
    this.loadVecExtension();
    this.db.pragma("journal_mode = WAL");
    this.initSchema();
  }

  /**
   * Load sqlite-vec's prebuilt loadable extension (.dylib/.so/.dll).
   *
   * `db.loadExtension` is a native SQLite C call that bypasses Electron's asar
   * fs shim, so in a packaged app the resolved path must point at the real file
   * under `app.asar.unpacked/`, not the virtual path inside `app.asar/`. We take
   * sqlite-vec's resolved path and rewrite `.asar/` -> `.asar.unpacked/`; this is
   * a no-op in dev / unpackaged runs (no `.asar` segment present). The extension
   * must also be listed in electron-builder `asarUnpack` so the file exists there.
   */
  private loadVecExtension(): void {
    const resolved = sqliteVec.getLoadablePath();
    const unpacked = resolved.replace(/\.asar([\\/])/, ".asar.unpacked$1");
    this.db.loadExtension(unpacked);
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS chunks (
        id      INTEGER PRIMARY KEY,
        file    TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        line    INTEGER NOT NULL,
        heading TEXT NOT NULL DEFAULT '',
        text    TEXT NOT NULL,
        hash    TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS emb_cache (
        hash     TEXT NOT NULL,
        embedder TEXT NOT NULL,
        dim      INTEGER NOT NULL,
        vec      BLOB NOT NULL,
        PRIMARY KEY (hash, embedder, dim)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
        text, content='chunks', content_rowid='id',
        tokenize='unicode61 remove_diacritics 2'
      );
    `);
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, value);
  }

  private resetVectors(dim: number): void {
    this.db.exec("DROP TABLE IF EXISTS vec_chunks;");
    this.db.exec(
      `CREATE VIRTUAL TABLE vec_chunks USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[${dim | 0}] distance_metric=cosine);`,
    );
  }

  hasVectors(): boolean {
    const t = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vec_chunks'")
      .get();
    if (!t) return false;
    const c = this.db.prepare("SELECT count(*) AS n FROM vec_chunks").get() as { n: number };
    return c.n > 0;
  }

  private clearChunks(): void {
    this.db.exec("INSERT INTO fts_chunks(fts_chunks) VALUES('delete-all');");
    this.db.exec("DELETE FROM chunks;");
    const hasVec = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vec_chunks'")
      .get();
    if (hasVec) this.db.exec("DELETE FROM vec_chunks;");
  }

  getCachedVec(hash: string, embedder: string, dim: number): Buffer | undefined {
    const row = this.db
      .prepare("SELECT vec FROM emb_cache WHERE hash=? AND embedder=? AND dim=?")
      .get(hash, embedder, dim) as { vec: Buffer } | undefined;
    return row?.vec;
  }

  putCachedVec(hash: string, embedder: string, dim: number, vec: Buffer): void {
    this.db
      .prepare("INSERT OR IGNORE INTO emb_cache(hash,embedder,dim,vec) VALUES(?,?,?,?)")
      .run(hash, embedder, dim, vec);
  }

  rebuildIndex(input: RebuildIndexInput): void {
    this.db.transaction(() => {
      this.clearChunks();
      if (input.mode === "hybrid" && input.dim) this.resetVectors(input.dim);
      for (const c of input.chunks) {
        this.db
          .prepare("INSERT INTO chunks(id,file,ordinal,line,heading,text,hash) VALUES(?,?,?,?,?,?,?)")
          .run(c.id, c.file, c.ordinal, c.line, c.heading, c.text, c.hash);
        this.db.prepare("INSERT INTO fts_chunks(rowid,text) VALUES(?,?)").run(c.id, c.text);
        if (input.mode === "hybrid" && c.vector) {
          this.db.prepare("INSERT INTO vec_chunks(chunk_id,embedding) VALUES(?,?)").run(BigInt(c.id), c.vector);
        }
      }
      this.setMeta("mode", input.mode);
      if (input.embedder) this.setMeta("embedder", input.embedder);
      if (input.dim) this.setMeta("dim", String(input.dim));
      this.setMeta("files", String(input.files));
      this.setMeta("chunks", String(input.chunks.length));
    })();
  }

  getChunk(id: number): ChunkRow | undefined {
    return this.db
      .prepare("SELECT id,file,ordinal,line,heading,text FROM chunks WHERE id=?")
      .get(id) as ChunkRow | undefined;
  }

  denseArm(qvec: Buffer, pool: number): DenseHit[] {
    const rows = this.db
      .prepare(`SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ? ORDER BY distance LIMIT ${pool | 0}`)
      .all(qvec) as { chunk_id: number | bigint; distance: number }[];
    return rows.map((r) => {
      const distance = Number(r.distance);
      return {
        id: Number(r.chunk_id),
        distance,
        cosine: 1 - distance,
      };
    });
  }

  ftsArm(match: string, pool: number): { id: number; rank: number }[] {
    if (!match) return [];
    try {
      return this.db
        .prepare(`SELECT rowid AS id, rank FROM fts_chunks WHERE fts_chunks MATCH ? ORDER BY rank LIMIT ${pool | 0}`)
        .all(match) as { id: number; rank: number }[];
    } catch {
      return [];
    }
  }

  close(): void {
    this.db.close();
  }
}

function parseFtsTokens(match: string): string[] {
  if (!match) return [];
  return [...match.matchAll(/"([^"]*)"/g)].map((m) => m[1].toLowerCase()).filter(Boolean);
}

function cosineFromBuffers(a: Buffer, b: Buffer): number {
  const fa = new Float32Array(a.buffer, a.byteOffset, a.byteLength / 4);
  const fb = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  const n = Math.min(fa.length, fb.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += fa[i] * fb[i];
    na += fa[i] * fa[i];
    nb += fb[i] * fb[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Test adapter: full Index interface, naive lexical arm (no FTS5 semantics). */
export class InMemoryIndex implements Index {
  readonly vaultRoot: string;
  readonly dir: string;

  private meta = new Map<string, string>();
  private chunks = new Map<number, ChunkRow & { hash: string }>();
  private vectors = new Map<number, Buffer>();
  private embCache = new Map<string, Buffer>();

  constructor(vaultRoot = "/test-vault") {
    this.vaultRoot = vaultRoot;
    this.dir = `${vaultRoot}/.cairn`;
  }

  getMeta(key: string): string | undefined {
    return this.meta.get(key);
  }

  hasVectors(): boolean {
    return this.vectors.size > 0;
  }

  getCachedVec(hash: string, embedder: string, dim: number): Buffer | undefined {
    return this.embCache.get(`${hash}|${embedder}|${dim}`);
  }

  putCachedVec(hash: string, embedder: string, dim: number, vec: Buffer): void {
    this.embCache.set(`${hash}|${embedder}|${dim}`, vec);
  }

  rebuildIndex(input: RebuildIndexInput): void {
    this.chunks.clear();
    this.vectors.clear();
    for (const c of input.chunks) {
      this.chunks.set(c.id, {
        id: c.id,
        file: c.file,
        ordinal: c.ordinal,
        line: c.line,
        heading: c.heading,
        text: c.text,
        hash: c.hash,
      });
      if (input.mode === "hybrid" && c.vector) this.vectors.set(c.id, c.vector);
    }
    this.meta.set("mode", input.mode);
    if (input.embedder) this.meta.set("embedder", input.embedder);
    if (input.dim) this.meta.set("dim", String(input.dim));
    this.meta.set("files", String(input.files));
    this.meta.set("chunks", String(input.chunks.length));
  }

  getChunk(id: number): ChunkRow | undefined {
    const c = this.chunks.get(id);
    if (!c) return undefined;
    const { hash: _hash, ...row } = c;
    return row;
  }

  denseArm(qvec: Buffer, pool: number): DenseHit[] {
    const rows: DenseHit[] = [];
    for (const [id, vec] of this.vectors) {
      const cosine = cosineFromBuffers(qvec, vec);
      rows.push({ id, distance: 1 - cosine, cosine });
    }
    rows.sort((a, b) => a.distance - b.distance);
    return rows.slice(0, pool);
  }

  ftsArm(match: string, pool: number): { id: number; rank: number }[] {
    const tokens = parseFtsTokens(match);
    if (tokens.length === 0) return [];
    const scored: { id: number; score: number }[] = [];
    for (const chunk of this.chunks.values()) {
      const lower = chunk.text.toLowerCase();
      const hits = tokens.filter((t) => lower.includes(t)).length;
      if (hits > 0) scored.push({ id: chunk.id, score: hits });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, pool).map((s, idx) => ({ id: s.id, rank: idx + 1 }));
  }

  close(): void {
    this.chunks.clear();
    this.vectors.clear();
    this.meta.clear();
    this.embCache.clear();
  }
}
