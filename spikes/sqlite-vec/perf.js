// Spike: does sqlite-vec scale like a true ANN index (flat latency) or a
// brute-force linear scan (latency grows with row count)? And what is the
// on-disk size of the single-file DB the PRD relies on?
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const fs = require('fs');

const DIM = 768;                       // nomic-embed-text dimension
const CHECKPOINTS = [10000, 50000, 100000, 200000, 500000];
const QUERIES = 25;                    // KNN queries to average per checkpoint
const K = 8;                           // PRD search_notes default k=8

const DB_PATH = '/tmp/cairn-vec-spike.db';
try { fs.unlinkSync(DB_PATH); } catch {}

const db = new Database(DB_PATH);
sqliteVec.load(db);
db.pragma('journal_mode = WAL');

db.exec(`CREATE VIRTUAL TABLE vec_items USING vec0(embedding float[${DIM}]);`);

function randVec() {
  const a = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) a[i] = Math.fround((i * 2654435761 % 1000) / 1000 - 0.5 + (i % 7) * 0.01);
  // deterministic-ish but varied per call via a rotating seed
  return a;
}
// vary vectors so they're not identical (avoid degenerate index behavior)
let seed = 12345;
function nextVec() {
  const a = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) {
    seed = (1103515245 * seed + 12345) & 0x7fffffff;
    a[i] = (seed / 0x7fffffff) - 0.5;
  }
  return a;
}

const insert = db.prepare('INSERT INTO vec_items(rowid, embedding) VALUES (?, ?)');
const knn = db.prepare(`SELECT rowid, distance FROM vec_items WHERE embedding MATCH ? ORDER BY distance LIMIT ${K}`);

function pct(arr, p) { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; }

let inserted = 0;
console.log(`dim=${DIM}  k=${K}  metric=L2(default)`);
console.log('rows\tinsert_total_s\tquery_p50_ms\tquery_p95_ms\tdb_file_MB');

for (const target of CHECKPOINTS) {
  const t0 = process.hrtime.bigint();
  const tx = db.transaction(() => {
    for (; inserted < target; inserted++) insert.run(BigInt(inserted + 1), Buffer.from(nextVec().buffer));
  });
  tx();
  const insertS = Number(process.hrtime.bigint() - t0) / 1e9;

  // warm + measure query latency
  const q = Buffer.from(nextVec().buffer);
  knn.all(q);
  const times = [];
  for (let i = 0; i < QUERIES; i++) {
    const query = Buffer.from(nextVec().buffer);
    const s = process.hrtime.bigint();
    knn.all(query);
    times.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  // checkpoint WAL so the main db file reflects size
  db.pragma('wal_checkpoint(TRUNCATE)');
  const sizeMB = fs.statSync(DB_PATH).size / 1048576;
  console.log(`${target}\t${insertS.toFixed(1)}\t${pct(times, 0.5).toFixed(1)}\t${pct(times, 0.95).toFixed(1)}\t${sizeMB.toFixed(0)}`);
}

db.close();
