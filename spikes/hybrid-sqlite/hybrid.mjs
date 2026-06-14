// Spike: does HYBRID (sqlite-vec dense + FTS5 keyword + app-side RRF) beat dense-only
// on the LOCKED stack (better-sqlite3 + sqlite-vec, Node/ESM)? DECIDED PARAMS G10.
//
// The claim under test (G10 "HYBRID ON by default"): there exist queries whose ONLY
// usable signal is an exact literal token — a function name / acronym the prose around
// it does NOT semantically describe (`useEffect`, `TLB`, `Bellman-Ford`, `mmap`). A
// dense embedder buries those (no lexical hook, weak semantic hook); FTS5 nails them.
// Fusing the two arms with RRF should pull the exact-term chunk into the top-k that
// dense-only missed — WITHOUT evicting the strong semantic hits dense-only already found.
//
// Query shapes + RRF formula are verbatim from G10:
//   dense:   SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ? ORDER BY distance LIMIT pool
//   keyword: SELECT rowid, rank      FROM fts_chunks  WHERE fts_chunks MATCH ? ORDER BY rank     LIMIT pool
//   rrf(c) = Σ_arm 1 / (K_RRF + rank_arm(c)), K_RRF=60, 1-based ranks, equal weights,
//            a chunk contributes a term ONLY for arms that returned it.
//
// Embedder is REAL: Qwen3-Embedding-0.6B via Ollama /api/embed (locked default, 1024-dim).
// Falls back to nomic-embed-text (768-dim) if the default is absent, and LABELS the verdict
// PROVISIONAL when it does. If Ollama is unreachable / no embedder present → clean skip.
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'node:fs';

const OLLAMA = process.env.OLLAMA_HOST || 'http://localhost:11434';
const DEFAULT_EMBED = 'qwen3-embedding:0.6b'; // G10 locked app-wide default (1024-dim)
const FALLBACK_EMBED = 'nomic-embed-text';    // G10 switch_target (768-dim) — PROVISIONAL only
const K = 8;            // search_notes returned count (G10 default)
const POOL = 64;        // per-arm over-fetch (G10 candidatePool default)
const K_RRF = 60;       // RRF constant (G10)
const DB_PATH = '/tmp/cairn-hybrid-spike.db';

// ---------------------------------------------------------------------------
// Corpus. Deliberately constructed so the spike exercises the REAL claim instead
// of a tautology (an earlier draft made each exact term the only chunk on its
// topic, so dense trivially ranked it #1 and there was nothing to recover).
//
// The honest construction (one cluster per exact term):
//   * A CLUSTER of same-topic chunks that carry the concept but NEVER the literal
//     token. These are strong DENSE matches for a bare-token query and crowd the
//     dense top-k.
//   * The GOLD chunk mentions the literal token only in PASSING, inside prose that
//     is not the most concept-central in its cluster (a war-story / ticket framing).
//     Dense therefore ranks the on-concept cluster-mates ABOVE the tangential gold,
//     pushing it past top-k=8 — where ONLY FTS5 (exact token) can find it again.
//   * The query is the bare literal token: it is in the query AND the gold AND
//     nowhere else, so FTS5 isolates exactly the gold.
//
// `exactGold:true` marks a chunk hybrid must RECOVER. `semantic:true` marks a
// paraphrase target dense finds and hybrid must KEEP (pollution guard). `file` is
// unique per chunk (gold lookup matches on it). Corpus stays < POOL=64 so the gold
// always carries a dense contribution into the RRF fuse.
// ---------------------------------------------------------------------------
const DOCS = [
  // === CLUSTER 1: React hooks. concept present, token "useEffect" only in the gold ===
  { file: 'react/usestate.md',   text: 'The useState hook returns a stateful value and a setter; calling the setter schedules a re-render with the new value on the next render pass.' },
  { file: 'react/usememo.md',    text: 'useMemo caches the result of an expensive calculation between renders, recomputing only when one of its dependencies changes, to avoid wasted work on every render.' },
  { file: 'react/usecallback.md',text: 'useCallback returns a memoized version of a callback so child components that depend on referential equality do not re-render needlessly.' },
  { file: 'react/lifecycle.md',  text: 'A function component re-runs top to bottom on every render; side effects must be coordinated with the render lifecycle so subscriptions are set up and torn down at the right time.' },
  { file: 'react/deps-array.md', text: 'The dependency array tells a hook when to re-run: list every reactive value it reads, or you risk a stale closure capturing old props and state.' },
  { file: 'react/cleanup.md',    text: 'An effect can return a cleanup function; the runtime invokes it before the next effect run and on unmount, which is how you cancel timers and unsubscribe from event sources.' },
  { file: 'react/strict-mode.md',text: 'In development, StrictMode intentionally double-invokes certain functions to surface impure render logic and missing cleanup early.' },
  { file: 'react/migration-ticket.md', exactGold: true,
    text: 'Closed out the flaky-dashboard ticket today. Root cause was an ordering issue we kept putting off; tagged the refactor branch useEffect-cleanup-fix and shipped it behind a flag. QA signed off, moving the card to done. Wrote up the postmortem in the team wiki for next sprint.' },

  // === CLUSTER 2: virtual memory. concept present, token "TLB" only in the gold ===
  { file: 'os/paging.md',        text: 'Virtual memory divides an address space into fixed-size pages mapped to physical frames, letting a process use more memory than is physically resident.' },
  { file: 'os/page-fault.md',    text: 'When a process touches an address whose page is not resident, the hardware traps to the kernel, which fetches the page from backing store and resumes the instruction.' },
  { file: 'os/page-table.md',    text: 'The page table maps virtual page numbers to physical frame numbers; multi-level tables keep this mapping compact for sparse address spaces.' },
  { file: 'os/working-set.md',   text: 'The working set is the collection of pages a process is actively using; when it exceeds available frames, the system thrashes, spending more time swapping than computing.' },
  { file: 'os/swapping.md',      text: 'Under memory pressure the kernel evicts least-recently-used pages to disk and pages them back on demand, trading latency for capacity.' },
  { file: 'os/cache-locality.md',text: 'Memory access patterns with good spatial and temporal locality let the hardware caches do their job, keeping hot data close to the processor.' },
  { file: 'os/perf-postmortem.md', exactGold: true,
    text: 'Postmortem from the latency spike: throughput collapsed once the dataset grew past a threshold. After a day of profiling, the smoking gun was TLB pressure under the new access pattern. We reorganized the hot loop and filed a follow-up to add a dashboard alert. Closing the incident as resolved.' },

  // === CLUSTER 3: shortest paths. concept present, token "Bellman-Ford" only in the gold ===
  { file: 'algo/dijkstra.md',    text: "Dijkstra's algorithm finds shortest paths from a source on a graph with non-negative edge weights using a priority queue to always expand the closest frontier node." },
  { file: 'algo/bfs.md',         text: 'Breadth-first search finds shortest paths in an unweighted graph by exploring all neighbours at the current depth before moving deeper.' },
  { file: 'algo/floyd.md',       text: 'Floyd-Warshall computes shortest paths between all pairs of vertices by progressively allowing more intermediate nodes in the dynamic-programming table.' },
  { file: 'algo/neg-weights.md', text: 'Graphs with negative edge weights break greedy frontier expansion; you need an algorithm that relaxes edges repeatedly and can detect negative cycles.' },
  { file: 'algo/relaxation.md',  text: 'Edge relaxation tightens the current best estimate to a vertex whenever a shorter route through a neighbour is discovered; repeating it to a fixed point yields shortest distances.' },
  { file: 'algo/graph-rep.md',   text: 'A weighted graph is stored as an adjacency list or matrix; the choice trades memory for the cost of enumerating a vertex neighbours.' },
  { file: 'algo/routing-ticket.md', exactGold: true,
    text: 'Shipped the routing fix. The first cut returned nonsense on certain inputs; replaced it on a branch named bellman-ford-rewrite and added regression tests for the bad cases. Slightly slower on big inputs but correct now, which is what the customer escalation needed. Marked the Jira as resolved.' },

  // === CLUSTER 4: rare identifier backstop. token "Xq7Lmn_init" exists ONLY in the gold ===
  // A genuinely rare symbol the embedder cannot represent — near-guaranteed FTS5 win,
  // insurance in case the well-known terms above resist burying.
  { file: 'lib/init-overview.md',  text: 'The bootstrap sequence wires up logging, reads the config file, opens the database connection pool and registers signal handlers before the server starts accepting requests.' },
  { file: 'lib/config.md',         text: 'Configuration is layered: built-in defaults, then a file on disk, then environment variables, with later sources overriding earlier ones at startup.' },
  { file: 'lib/lifecycle.md',      text: 'Each subsystem exposes a start and a stop entry point; the supervisor calls them in dependency order on boot and in reverse order on graceful shutdown.' },
  { file: 'lib/error-handling.md', text: 'A failure during startup aborts the boot sequence, unwinds whatever was already initialized, and exits with a non-zero status so the supervisor can restart cleanly.' },
  { file: 'lib/changelog-entry.md', exactGold: true,
    text: 'Internal note: the legacy entry point was renamed for the v3 refactor. Anything still calling Xq7Lmn_init must migrate to the new supervisor API before the next release; the shim is deprecated and will be deleted. Tracked under the v3-cleanup epic.' },

  // === Semantic / paraphrase targets: NO lexical overlap with their query ===
  // Dense is the only arm that finds these; hybrid must NOT evict them (pollution guard).
  { file: 'bio/photosynthesis.md', semantic: true,
    text: 'Green plants capture energy from sunlight and use it to build sugars from carbon dioxide and water, releasing oxygen as a by-product. This process sustains nearly all food chains on the planet.' },
  { file: 'physics/relativity.md', semantic: true,
    text: 'According to general relativity, massive objects curve the fabric of spacetime, and what we perceive as the force of gravity is really other bodies following the straightest possible paths through that curved geometry.' },
  { file: 'finance/inflation.md', semantic: true,
    text: 'When the general level of prices climbs over time, each unit of currency buys fewer goods than before, so the purchasing power of people holding cash quietly erodes even if their nominal wages stay the same.' },

  // === Distractors / filler: contest the top-k, target of no query ===
  { file: 'misc/weather.md', text: 'Cold fronts form when a cooler air mass pushes under warmer air, often bringing sharp temperature drops and storms.' },
  { file: 'misc/coffee.md',  text: 'Espresso forces hot water through finely-ground coffee under pressure, producing a concentrated shot topped with crema.' },
  { file: 'misc/tides.md',   text: 'Ocean tides rise and fall mainly because of the gravitational pull of the moon, with the sun making a smaller contribution.' },
  { file: 'misc/origami.md', text: 'Folding a single square of paper, with no cuts or glue, can yield cranes, boxes and surprisingly rigid structures.' },
];

// Test queries paired with the single gold chunk they target (by unique `file`).
//   kind:'exact'    — bare literal-token query; gold buried by dense, FTS5 must rescue it.
//   kind:'semantic' — paraphrase query; gold is a semantic chunk dense finds and hybrid
//                     must KEEP (these guard against RRF pollution).
const QUERIES = [
  { q: 'useEffect',                                         gold: 'react/migration-ticket.md', kind: 'exact' },
  { q: 'TLB',                                               gold: 'os/perf-postmortem.md',     kind: 'exact' },
  { q: 'Bellman-Ford',                                      gold: 'algo/routing-ticket.md',    kind: 'exact' },
  { q: 'Xq7Lmn_init',                                       gold: 'lib/changelog-entry.md',    kind: 'exact' },
  { q: 'how do plants make food from sunlight',             gold: 'bio/photosynthesis.md',     kind: 'semantic' },
  { q: 'why do heavy objects bend space and cause gravity', gold: 'physics/relativity.md',     kind: 'semantic' },
  { q: 'why does money lose value as prices go up',         gold: 'finance/inflation.md',      kind: 'semantic' },
];

// ---------------------------------------------------------------------------
// Embedder selection (REAL). Prefer the G10 locked default; fall back to nomic and
// flag the run PROVISIONAL. Dimension is read off the live vectors, not assumed,
// because the fallback is 768-dim and vec0's float[DIM] column must match exactly.
// ---------------------------------------------------------------------------
async function listModels() {
  const r = await fetch(`${OLLAMA}/api/tags`);
  if (!r.ok) throw new Error(`HTTP ${r.status} from /api/tags`);
  const j = await r.json();
  return (j.models || []).map((m) => m.name); // e.g. 'qwen3-embedding:0.6b', 'nomic-embed-text:latest'
}

// Ollama tags carry an explicit ':tag' (often ':latest'); match on the bare name too.
function hasModel(models, want) {
  return models.some((m) => m === want || m.split(':')[0] === want.split(':')[0]);
}

async function pickEmbedder() {
  const forced = process.env.EMBED_MODEL;
  const models = await listModels();
  if (forced) {
    if (!hasModel(models, forced)) throw new Error(`forced EMBED_MODEL "${forced}" not pulled (have: ${models.join(', ') || 'none'})`);
    return { model: forced, provisional: forced.split(':')[0] !== DEFAULT_EMBED.split(':')[0] };
  }
  if (hasModel(models, DEFAULT_EMBED)) return { model: DEFAULT_EMBED, provisional: false };
  if (hasModel(models, FALLBACK_EMBED)) return { model: FALLBACK_EMBED, provisional: true };
  throw new Error(`no embedder available — pull ${DEFAULT_EMBED} (have: ${models.join(', ') || 'none'})`);
}

async function embed(model, input) {
  const r = await fetch(`${OLLAMA}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status} from /api/embed: ${body.slice(0, 200)}`);
  }
  const j = await r.json();
  if (!j.embeddings || !j.embeddings.length) throw new Error(`no embeddings in response: ${JSON.stringify(j).slice(0, 200)}`);
  return j.embeddings; // array of vectors, one per input
}

// ---------------------------------------------------------------------------
// FTS5 MATCH sanitizer (the G10 open-risk: "free-text->FTS5-MATCH must be robust;
// malformed input degrades the FTS arm to empty, never throws").
//
// Strategy: never pass raw user text to MATCH. Tokenize on non-word runs (keeping the
// '-' inside tokens like Bellman-Ford as a separator -> two FTS tokens), then emit each
// token as a double-quoted FTS5 string (embedded '"' doubled per FTS5 escaping). Quoting
// neutralises every FTS5 operator (AND OR NOT NEAR * ^ : ( ) "). Tokens are OR-ed so a
// multi-word query still hits docs that contain ANY term — recall-first, which is what
// the keyword arm is for in a hybrid setup. Empty after tokenizing -> '' -> caller skips.
// ---------------------------------------------------------------------------
function sanitizeForFts(raw) {
  const tokens = (raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(Boolean);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

// ---------------------------------------------------------------------------
// Schema (subset of G5 DDL: chunks + vec_chunks + fts_chunks). DIM templated at runtime.
// ---------------------------------------------------------------------------
function buildDb(dim) {
  try { fs.unlinkSync(DB_PATH); } catch {}
  const db = new Database(DB_PATH);
  sqliteVec.load(db);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE chunks (
      id   INTEGER PRIMARY KEY,
      file TEXT NOT NULL,
      text TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE vec_chunks USING vec0(
      chunk_id INTEGER PRIMARY KEY,
      embedding float[${dim}] distance_metric=cosine
    );
    CREATE VIRTUAL TABLE fts_chunks USING fts5(
      text,
      content='chunks',
      content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );
  `);
  return db;
}

// ---------------------------------------------------------------------------
// RRF fuse: equal weights, 1-based ranks, a chunk contributes a term ONLY for arms
// that returned it (G10). `arms` is an array of best-first ordered id-lists.
// ---------------------------------------------------------------------------
function rrfFuse(arms) {
  const score = new Map();
  for (const ranked of arms) {
    ranked.forEach((chunkId, idx) => {
      const rank = idx + 1; // 1-based
      score.set(chunkId, (score.get(chunkId) || 0) + 1 / (K_RRF + rank));
    });
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([chunkId, rrf]) => ({ chunkId, rrf }));
}

// ---------------------------------------------------------------------------
async function main() {
  const { model, provisional } = await pickEmbedder();
  console.log(`embedder = ${model}${provisional ? '  [FALLBACK -> verdict is PROVISIONAL]' : '  [G10 locked default]'}`);

  // 1) Embed the corpus once; derive DIM from the live vectors.
  const docVecs = await embed(model, DOCS.map((d) => d.text));
  const DIM = docVecs[0].length;
  console.log(`indexed ${DOCS.length} chunks  dim=${DIM}  k=${K}  pool=${POOL}  K_RRF=${K_RRF}\n`);

  const db = buildDb(DIM);
  const insChunk = db.prepare('INSERT INTO chunks(id, file, text) VALUES (?, ?, ?)');
  const insVec   = db.prepare('INSERT INTO vec_chunks(chunk_id, embedding) VALUES (?, ?)');
  const insFts   = db.prepare('INSERT INTO fts_chunks(rowid, text) VALUES (?, ?)');
  db.transaction(() => {
    DOCS.forEach((d, i) => {
      const id = i + 1;
      insChunk.run(id, d.file, d.text);
      insVec.run(BigInt(id), Buffer.from(Float32Array.from(docVecs[i]).buffer)); // vec0 PK as BigInt
      insFts.run(id, d.text); // external-content sync done manually (G5 discipline)
    });
  })();

  const denseStmt = db.prepare(
    `SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ? ORDER BY distance LIMIT ${POOL}`
  );
  const ftsStmt = db.prepare(
    `SELECT rowid AS chunk_id, rank FROM fts_chunks WHERE fts_chunks MATCH ? ORDER BY rank LIMIT ${POOL}`
  );
  const fileOf = db.prepare('SELECT file FROM chunks WHERE id = ?');
  const idOfFile = (f) => DOCS.findIndex((d) => d.file === f) + 1;
  const label = (id) => fileOf.get(id).file;

  function denseArm(qvec) {
    return denseStmt.all(Buffer.from(Float32Array.from(qvec).buffer)).map((r) => r.chunk_id);
  }
  function ftsArm(q) {
    const match = sanitizeForFts(q);
    if (!match) return [];
    try {
      return ftsStmt.all(match).map((r) => r.chunk_id);
    } catch {
      return []; // G10: malformed MATCH -> empty arm, never throw
    }
  }

  // 2) Run each query: dense-only top-k vs hybrid top-k, and measure recovery / pollution.
  let recovered = 0;             // exact-term golds hybrid pulled into top-k that dense-only missed
  let exactQueries = 0;
  let evictedSemantic = 0;       // semantic golds dense-only had in top-k but hybrid dropped (pollution)
  let semanticDenseFound = 0;    // semantic golds dense-only actually had in top-k (denominator)

  for (const { q, gold, kind } of QUERIES) {
    const [qvec] = await embed(model, [q]);
    const dense = denseArm(qvec);
    const fts = ftsArm(q);
    const denseTopK = dense.slice(0, K);
    const hybridTopK = rrfFuse([dense, fts]).slice(0, K).map((r) => r.chunkId);
    const goldId = idOfFile(gold);
    const denseRank = denseTopK.indexOf(goldId);   // -1 = missed
    const hybridRank = hybridTopK.indexOf(goldId);

    console.log(`QUERY [${kind}]: ${JSON.stringify(q)}  (gold = ${gold})`);
    console.log(`  dense-only top-${K}: [${denseTopK.map(label).join(', ')}]`);
    console.log(`  hybrid    top-${K}: [${hybridTopK.map(label).join(', ')}]`);
    console.log(`  fts arm returned : [${fts.map(label).join(', ') || '(empty)'}]`);
    console.log(`  gold dense-rank=${denseRank}  hybrid-rank=${hybridRank}`);

    if (kind === 'exact') {
      exactQueries++;
      // Recovery: gold is in hybrid top-k AND dense-only did NOT have it in top-k
      // (the literal-token chunk dense buried, FTS5+RRF rescued).
      const wasMissedByDense = denseRank === -1;
      const inHybrid = hybridRank !== -1;
      if (wasMissedByDense && inHybrid) {
        recovered++;
        console.log(`  -> RECOVERED: dense-only missed it, hybrid put it at rank ${hybridRank}`);
      } else if (!wasMissedByDense) {
        console.log(`  -> dense-only already had it (no rescue needed for this query)`);
      } else {
        console.log(`  -> NOT recovered: still outside hybrid top-k`);
      }
    } else { // semantic
      // Pollution guard: a strong semantic hit dense-only found must SURVIVE in hybrid.
      if (denseRank !== -1) {
        semanticDenseFound++;
        if (hybridRank === -1) {
          evictedSemantic++;
          console.log(`  -> POLLUTION: dense-only had this semantic gold, hybrid EVICTED it`);
        } else {
          console.log(`  -> kept: semantic gold survived RRF (rank ${hybridRank})`);
        }
      } else {
        console.log(`  -> dense-only did NOT find this semantic gold in top-k (not a pollution candidate)`);
      }
    }
    console.log();
  }

  // 3) Verdict — REAL, no TODO.
  //   PASS = hybrid recovered >= 1 exact-term gold that dense-only ranked outside top-k
  //          AND evicted 0 of the semantic golds dense-only had in its top-k.
  console.log('---');
  console.log(`exact-term queries          : ${exactQueries}`);
  console.log(`  recovered by hybrid       : ${recovered}  (>=1 required)`);
  console.log(`semantic golds dense found  : ${semanticDenseFound}`);
  console.log(`  evicted by hybrid         : ${evictedSemantic}  (0 required)`);
  const pass = recovered >= 1 && evictedSemantic === 0;
  const tag = provisional ? `PROVISIONAL ${pass ? 'PASS' : 'FAIL'} (fallback embedder ${model})` : (pass ? 'PASS' : 'FAIL');
  console.log(`\nVERDICT: ${tag}`);
  if (provisional) {
    console.log(`  NOTE: ran on fallback ${model}, not the G10 default ${DEFAULT_EMBED}.`);
    console.log(`  Re-run with the default embedder to make this authoritative.`);
  }

  db.close();
  process.exit(pass ? 0 : 1);
}

// Graceful degradation: a missing prerequisite is a clean labelled SKIP, not a crash.
main().catch((err) => {
  const msg = String(err && err.message ? err.message : err);
  const offline = /ECONNREFUSED|fetch failed|ENOTFOUND|connect|\/api\/tags/i.test(msg);
  const noModel = /not pulled|no embedder|not found|no models|pull/i.test(msg);
  if (offline) {
    console.log(`\n[skip] Ollama not reachable at ${OLLAMA} — start it (\`ollama serve\`) and retry.`);
  } else if (noModel) {
    console.log(`\n[skip] ${msg}`);
  } else {
    console.log(`\n[skip] could not run live embed (${msg}).`);
  }
  console.log('       (harness ran without crashing; PASS/FAIL needs a live embedder.)');
  process.exit(2); // distinct from PASS(0)/FAIL(1): SKIP, no verdict produced
});
