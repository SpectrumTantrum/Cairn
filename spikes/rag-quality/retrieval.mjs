// Spike: does Qwen3-Embedding-0.6B (1024-dim, the locked app-wide default embedder)
// retrieve the RIGHT chunk into the TOP 3 for a natural-language question >= 80%
// of the time? This is a pure EMBEDDING-QUALITY question, so retrieval here is
// brute-force cosine in JS over a fixture corpus (NO sqlite-vec / FTS5 / RRF) —
// the index is deliberately removed as a confounding variable. If the embedder
// can't rank the right chunk top-3 here, no index tuning will save it.
//
// PASS = top-3 recall >= 80% across the eval pairs, MEASURED WITH qwen3-embedding:0.6b.
// A run on the fallback (nomic-embed-text, 768-dim) is labelled PROVISIONAL — it
// tells you the corpus/evals are sane but does NOT clear the locked-model bar.
// Latency is NOT measured (dev hardware != the 8-16GB student target).
//
//   node retrieval.mjs            # auto-detects embedder (prefers qwen3, else nomic)
//   EMBED_MODEL=bge-m3 node ...   # force a specific model

import { buildChunks } from './chunker.mjs';
import { EVAL } from './evals.mjs';

const OLLAMA = process.env.OLLAMA_HOST || 'http://localhost:11434';
const TOP_K = 3;            // the spike question is specifically about TOP-3
const PASS_THRESHOLD = 0.8; // PASS = >= 80% top-3 recall
const MIN_EVAL_PAIRS = 50;  // the bar is only trustworthy with a real eval set
const CORPUS_MIN = 50, CORPUS_MAX = 120; // expected fixture chunk-count range

// The locked default and the permitted fallback. Dim is per-model: a fallback run
// that still asserted 1024 would mislabel itself, so dim travels WITH the choice.
const PREFERRED = { model: 'qwen3-embedding:0.6b', dim: 1024, locked: true };
const FALLBACK = { model: 'nomic-embed-text', dim: 768, locked: false };

// --- cosine similarity (same as spikes/ollama/capability.mjs) ----------------
function cos(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb));
}

// --- Ollama: list installed models (GET /api/tags) ---------------------------
async function listModels() {
  const r = await fetch(`${OLLAMA}/api/tags`);
  if (!r.ok) throw new Error(`HTTP ${r.status} from /api/tags`);
  const j = await r.json();
  return (j.models || []).map((m) => m.name); // e.g. 'qwen3-embedding:0.6b'
}

// --- Ollama embed round-trip (POST /api/embed, dense only) -------------------
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
  if (!j.embeddings) throw new Error(`no embeddings in response: ${JSON.stringify(j).slice(0, 200)}`);
  return j.embeddings; // array of vectors, one per input
}

// A tag may be 'qwen3-embedding:0.6b' or bare 'nomic-embed-text' (':latest' implied).
function hasModel(installed, want) {
  return installed.some((m) => m === want || m === `${want}:latest` || m.split(':')[0] === want.split(':')[0]);
}

// Pick the embedder: explicit override > preferred (locked) > fallback (provisional).
function chooseEmbedder(installed) {
  const override = process.env.EMBED_MODEL;
  if (override) {
    const dim = override.startsWith('qwen3-embedding') ? 1024
      : override.startsWith('nomic') ? 768 : 0; // 0 => "trust whatever dim comes back"
    return { model: override, dim, locked: override.startsWith('qwen3-embedding'), why: 'EMBED_MODEL override' };
  }
  if (hasModel(installed, PREFERRED.model)) return { ...PREFERRED, why: 'locked default present' };
  if (hasModel(installed, FALLBACK.model)) return { ...FALLBACK, why: 'locked default absent -> fallback' };
  return null;
}

// --- fixture integrity guards (catch desync between evals and chunk ids) -----
function assertFixtureIntegrity(chunks) {
  const ids = new Set(chunks.map((c) => c.id));
  if (chunks.length < CORPUS_MIN || chunks.length > CORPUS_MAX) {
    throw new Error(`corpus has ${chunks.length} chunks, expected ${CORPUS_MIN}-${CORPUS_MAX} (see chunker.mjs / notes/)`);
  }
  const bad = EVAL.filter((e) => !ids.has(e.expected_chunk_id));
  if (bad.length) {
    throw new Error(`${bad.length} eval pair(s) point at a non-existent chunk id: ${bad.map((e) => e.expected_chunk_id).join(', ')} — re-author against \`node chunker.mjs\``);
  }
  const okCats = new Set(['paraphrase', 'exact-term', 'multi-hop']);
  const badCat = EVAL.filter((e) => !okCats.has(e.category));
  if (badCat.length) throw new Error(`${badCat.length} eval pair(s) have an unknown category`);
}

// --- main -------------------------------------------------------------------
async function main() {
  const installed = await listModels();
  const choice = chooseEmbedder(installed);
  if (!choice) {
    console.log(`\n[skip] neither '${PREFERRED.model}' nor '${FALLBACK.model}' is installed.`);
    console.log(`       installed: ${installed.join(', ') || '(none)'}`);
    console.log(`       fix: \`ollama pull ${PREFERRED.model}\` (the locked default) and retry.`);
    process.exit(0);
  }

  const chunks = buildChunks();
  assertFixtureIntegrity(chunks); // throws loudly on any desync — fail, don't fudge

  console.log(`embedder   = ${choice.model}  (${choice.why})`);
  console.log(`mode       = ${choice.locked ? 'LOCKED-MODEL run (counts for the 80% bar)' : 'PROVISIONAL run (fallback model — does NOT clear the bar)'}`);
  console.log(`corpus     = ${chunks.length} chunks from notes/  |  eval pairs = ${EVAL.length}  |  top-k = ${TOP_K}`);
  console.log(`PASS       = top-3 recall >= ${PASS_THRESHOLD * 100}%${EVAL.length < MIN_EVAL_PAIRS ? `  [!] only ${EVAL.length} pairs (< ${MIN_EVAL_PAIRS})` : ''}`);

  // 1) Embed the whole corpus once. (Symmetric: query and doc go through the same
  //    model with no task-instruction prefix — see the caveat printed at the end.)
  const chunkVecs = await embed(choice.model, chunks.map((c) => c.text));
  const dim = chunkVecs[0]?.length ?? 0;
  const dimNote = choice.dim ? (dim === choice.dim ? 'OK' : `<- MISMATCH (expected ${choice.dim}, check model tag)`) : '(no expected dim for this model)';
  console.log(`embed dim  = ${dim}  ${dimNote}\n`);

  // 2) For each eval pair: embed the question, cosine-rank chunks, take top-3.
  const byCat = {}; // category -> { hits, total }
  let hits = 0;
  for (const { question, expected_chunk_id, category } of EVAL) {
    const [qvec] = await embed(choice.model, [question]);
    const ranked = chunks
      .map((c, i) => ({ id: c.id, sim: cos(qvec, chunkVecs[i]) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, TOP_K);
    const top3ids = ranked.map((r) => r.id);
    const hit = top3ids.includes(expected_chunk_id);
    if (hit) hits++;
    byCat[category] ??= { hits: 0, total: 0 };
    byCat[category].total++;
    if (hit) byCat[category].hits++;
    if (!hit) {
      console.log(`  MISS  expect #${expected_chunk_id}  top3=[${top3ids.join(', ')}]  (${category})  q="${question.slice(0, 64)}"`);
    }
  }

  // 3) Score + verdict.
  const recall = hits / EVAL.length;
  console.log(`\nper-category top-3 recall:`);
  for (const cat of ['exact-term', 'paraphrase', 'multi-hop']) {
    const c = byCat[cat];
    if (c) console.log(`  ${cat.padEnd(11)} ${c.hits}/${c.total} = ${((c.hits / c.total) * 100).toFixed(1)}%`);
  }
  console.log(`\noverall top-3 recall: ${hits}/${EVAL.length} = ${(recall * 100).toFixed(1)}%`);

  const cleared = recall >= PASS_THRESHOLD;
  if (choice.locked) {
    console.log(`verdict: ${cleared ? 'PASS' : 'FAIL'} (locked model ${choice.model}, threshold ${PASS_THRESHOLD * 100}%)`);
  } else {
    console.log(`verdict: PROVISIONAL ${cleared ? 'clears' : 'below'} ${PASS_THRESHOLD * 100}% on FALLBACK ${choice.model} — pull ${PREFERRED.model} for the real verdict`);
  }

  console.log(`\ncaveat: query and chunk are embedded SYMMETRICALLY (no task-instruction`);
  console.log(`        prefix on the query). Qwen3-Embedding is trained for asymmetric`);
  console.log(`        use; a query prefix could move recall. Symmetric is what a naive`);
  console.log(`        v1 does, so this is a fair floor — flagged, not corrected here.`);

  // Non-zero exit on a real FAIL so CI/automation can branch on it; PROVISIONAL exits 0.
  process.exit(choice.locked && !cleared ? 1 : 0);
}

// Graceful degradation: "needs Ollama" must not mean "crashes without Ollama".
main().catch((err) => {
  const msg = String(err && err.message ? err.message : err);
  const offline = /ECONNREFUSED|fetch failed|ENOTFOUND|connect/i.test(msg);
  if (offline) {
    console.log(`\n[skip] Ollama not reachable at ${OLLAMA} — start it (\`ollama serve\`) and retry.`);
    process.exit(0);
  }
  // Fixture-integrity failures and other bugs are REAL failures — surface them.
  console.error(`\n[error] ${msg}`);
  process.exit(1);
});
