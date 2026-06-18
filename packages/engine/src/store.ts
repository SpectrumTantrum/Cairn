// The persistent index under <vault>/.cairn/index.db: chunks + FTS5 keyword index +
// (when hybrid) a sqlite-vec dense table + a content-addressed embedding cache.
// Per CONTEXT.md the index is DISPOSABLE and rebuilt from the vault on demand; the vault
// (the Markdown files) is the source of truth. Schema is the G5 subset; ports the table
// shapes + query forms proven in spikes/hybrid-sqlite.

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

export class Store {
  readonly db: Database.Database;
  readonly dir: string;
  readonly vaultRoot: string;

  constructor(vaultRoot: string) {
    this.vaultRoot = vaultRoot;
    this.dir = join(vaultRoot, ".cairn");
    mkdirSync(this.dir, { recursive: true });
    this.db = new Database(join(this.dir, "index.db"));
    sqliteVec.load(this.db);
    this.db.pragma("journal_mode = WAL");
    this.initSchema();
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

  setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, value);
  }

  // vec0's dimension is fixed at create time, so a (re)index drops & recreates the table.
  resetVectors(dim: number): void {
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

  // Clear all chunk rows + FTS + vectors for a full rebuild (emb_cache is preserved).
  clearChunks(): void {
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

  insertChunk(
    id: number,
    file: string,
    ordinal: number,
    line: number,
    heading: string,
    text: string,
    hash: string,
  ): void {
    this.db
      .prepare("INSERT INTO chunks(id,file,ordinal,line,heading,text,hash) VALUES(?,?,?,?,?,?,?)")
      .run(id, file, ordinal, line, heading, text, hash);
    this.db.prepare("INSERT INTO fts_chunks(rowid,text) VALUES(?,?)").run(id, text);
  }

  insertVec(id: number, vec: Buffer): void {
    this.db.prepare("INSERT INTO vec_chunks(chunk_id,embedding) VALUES(?,?)").run(BigInt(id), vec);
  }

  transaction(fn: () => void): void {
    this.db.transaction(fn)();
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
      return []; // malformed MATCH degrades to an empty arm, never throws (G10)
    }
  }

  close(): void {
    this.db.close();
  }
}
