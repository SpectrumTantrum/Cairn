// Decisive retrieval eval: does Qwen3-Embedding-0.6B actually beat lexical retrieval
// (TF-IDF / BM25), and does hybrid beat both — on human-judged BEIR benchmarks?
//
//   node run.mjs                 # both datasets
//   node run.mjs scifact         # one dataset
//   MAX_DOCS=500 MAX_Q=20 node run.mjs scifact   # fast smoke test (numbers meaningless)
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadDataset } from './lib/beir.mjs';
import { tokenize } from './lib/text.mjs';
import { buildLexical } from './lib/lexical.mjs';
import { loadOrEmbed, normalizeRows, rankDense } from './lib/dense.mjs';
import { successAtK, recallAtK, mrrAtK, ndcgAtK, rrf, overlapCoverage } from './lib/metrics.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');
const CACHE = join(DATA, 'cache');
const MODEL = process.env.EMBED_MODEL || 'qwen3-embedding:0.6b';
const POOL = 100;
const MAX_DOCS = Number(process.env.MAX_DOCS || 0);
const MAX_Q = Number(process.env.MAX_Q || 0);

const PUBLISHED_BM25_NDCG10 = { scifact: 0.665, nfcorpus: 0.325 }; // BEIR paper anchors
const TASK = {
  scifact: 'Given a scientific claim, retrieve documents that support or refute the claim.',
  nfcorpus: 'Given a question, retrieve relevant documents that best answer the question.',
};

const docText = (d) => `${d.title}. ${d.text}`.slice(0, 2000);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pct = (x) => (x * 100).toFixed(1).padStart(5);

async function runDataset(name) {
  console.log(`\n=== DATASET: ${name} ===`);
  const { corpus, queries, qrels } = loadDataset(DATA, name);

  let docIds = [...corpus.keys()];
  if (MAX_DOCS) docIds = docIds.slice(0, MAX_DOCS);
  const docTexts = docIds.map((id) => docText(corpus.get(id)));
  let qids = [...queries.keys()];
  if (MAX_Q) qids = qids.slice(0, MAX_Q);
  console.log(`corpus=${docIds.length} docs   test queries=${qids.length}${MAX_DOCS || MAX_Q ? '   [SMOKE — capped, numbers meaningless]' : ''}`);

  // ---- lexical index ----
  const docTokens = docTexts.map((t) => tokenize(t));
  const lex = buildLexical(docIds.map((id, i) => ({ id, tokens: docTokens[i] })));

  // ---- dense embeddings (cached) ----
  const tag = MAX_DOCS || MAX_Q ? `${name}.smoke` : name;
  const docVecs = normalizeRows(await loadOrEmbed(MODEL, docTexts, join(CACHE, `${tag}.docs.json`), `${name} docs`));
  const qSym = qids.map((id) => queries.get(id));
  const qIns = qSym.map((q) => `Instruct: ${TASK[name]}\nQuery: ${q}`);
  const qVecSym = normalizeRows(await loadOrEmbed(MODEL, qSym, join(CACHE, `${tag}.q-sym.json`), `${name} q-sym`));
  const qVecIns = normalizeRows(await loadOrEmbed(MODEL, qIns, join(CACHE, `${tag}.q-ins.json`), `${name} q-instruct`));

  // ---- query -> gold lexical overlap (for bucketing) ----
  const goldTokCache = new Map();
  const goldTok = (id) => {
    if (!goldTokCache.has(id)) { const d = corpus.get(id); goldTokCache.set(id, new Set(d ? tokenize(docText(d)) : [])); }
    return goldTokCache.get(id);
  };
  const coverage = new Map();
  for (const qid of qids) {
    const gold = new Set();
    for (const did of qrels.get(qid).keys()) for (const t of goldTok(did)) gold.add(t);
    coverage.set(qid, overlapCoverage(tokenize(queries.get(qid)), gold));
  }
  const covSorted = [...coverage.values()].sort((a, b) => a - b);
  const covMedian = covSorted[Math.floor(covSorted.length / 2)] || 0;

  // ---- evaluate ----
  const methods = ['tfidf', 'bm25', 'dense-sym', 'dense-instruct', 'hybrid(d+bm25)'];
  const agg = {};
  for (const m of methods) agg[m] = { ndcg: [], r3: [], r10: [], mrr: [], s1: [], low: [], high: [] };

  for (let qi = 0; qi < qids.length; qi++) {
    const qid = qids[qi];
    const rel = qrels.get(qid);
    const relSet = new Set(rel.keys());
    const qTokens = tokenize(queries.get(qid));
    const r = {
      'tfidf': lex.rankTFIDF(qTokens, POOL),
      'bm25': lex.rankBM25(qTokens, POOL),
      'dense-sym': rankDense(qVecSym[qi], docVecs, docIds, POOL),
      'dense-instruct': rankDense(qVecIns[qi], docVecs, docIds, POOL),
    };
    r['hybrid(d+bm25)'] = rrf([r['dense-instruct'], r['bm25']], { k: 60, P: POOL });
    const isLow = coverage.get(qid) <= covMedian;
    for (const m of methods) {
      const ids = r[m].map((x) => x.id);
      const nd = ndcgAtK(ids, rel, 10);
      agg[m].ndcg.push(nd); agg[m].r3.push(recallAtK(ids, relSet, 3)); agg[m].r10.push(recallAtK(ids, relSet, 10));
      agg[m].mrr.push(mrrAtK(ids, relSet, 10)); agg[m].s1.push(successAtK(ids, relSet, 1));
      (isLow ? agg[m].low : agg[m].high).push(nd);
    }
    if (qi % 50 === 0) process.stdout.write(`\r  [eval] ${qi}/${qids.length}`);
  }
  process.stdout.write(`\r  [eval] ${qids.length}/${qids.length}\n`);

  // ---- report ----
  console.log(`\nmethod            nDCG@10  R@3    R@10   MRR@10  S@1`);
  for (const m of methods) {
    const a = agg[m];
    console.log(`  ${m.padEnd(15)} ${pct(mean(a.ndcg))}  ${pct(mean(a.r3))}  ${pct(mean(a.r10))}  ${pct(mean(a.mrr))}  ${pct(mean(a.s1))}`);
  }
  const myBm25 = mean(agg['bm25'].ndcg);
  const anchor = PUBLISHED_BM25_NDCG10[name];
  console.log(`\n  BM25 sanity: mine nDCG@10=${(myBm25 * 100).toFixed(1)}  vs published ≈ ${anchor ? (anchor * 100).toFixed(1) : '?'}  (close ⇒ harness sound)`);

  console.log(`\n  by query→gold lexical overlap (median coverage=${covMedian.toFixed(2)}):`);
  console.log(`    LOW-overlap  (n=${agg['bm25'].low.length}) nDCG@10:  bm25=${pct(mean(agg['bm25'].low))}  dense-instruct=${pct(mean(agg['dense-instruct'].low))}  hybrid=${pct(mean(agg['hybrid(d+bm25)'].low))}`);
  console.log(`    HIGH-overlap (n=${agg['bm25'].high.length}) nDCG@10:  bm25=${pct(mean(agg['bm25'].high))}  dense-instruct=${pct(mean(agg['dense-instruct'].high))}  hybrid=${pct(mean(agg['hybrid(d+bm25)'].high))}`);

  const dI = mean(agg['dense-instruct'].ndcg), bm = myBm25, hy = mean(agg['hybrid(d+bm25)'].ndcg);
  const dILow = mean(agg['dense-instruct'].low), bmLow = mean(agg['bm25'].low);
  console.log(`\n  VERDICT (${name}):`);
  console.log(`    dense-instruct vs BM25 overall:      ${(dI * 100).toFixed(1)} vs ${(bm * 100).toFixed(1)}  → ${dI > bm ? 'dense wins' : 'BM25 wins/ties'}`);
  console.log(`    dense-instruct vs BM25 LOW-overlap:  ${(dILow * 100).toFixed(1)} vs ${(bmLow * 100).toFixed(1)}  → ${dILow > bmLow ? 'dense wins where it should' : 'embedder does NOT beat lexical even on paraphrase'}`);
  console.log(`    hybrid vs best single arm:           ${(hy * 100).toFixed(1)} vs ${(Math.max(dI, bm) * 100).toFixed(1)}  → ${hy >= Math.max(dI, bm) ? 'hybrid ≥ best arm' : 'hybrid worse than best arm'}`);
  return { name, dI, bm, hy, dILow, bmLow, myBm25, anchor };
}

async function main() {
  const arg = process.argv[2];
  const sets = arg ? [arg] : ['scifact', 'nfcorpus'];
  console.log(`embedder = ${MODEL}   pool=${POOL}`);
  const out = [];
  for (const s of sets) out.push(await runDataset(s));
  console.log(`\n================ SUMMARY (nDCG@10) ================`);
  for (const r of out) {
    console.log(`${r.name.padEnd(9)} dense-instruct=${(r.dI * 100).toFixed(1)}  BM25=${(r.bm * 100).toFixed(1)}  hybrid=${(r.hy * 100).toFixed(1)}  | LOW-overlap dense=${(r.dILow * 100).toFixed(1)} vs bm25=${(r.bmLow * 100).toFixed(1)}`);
  }
}

main().catch((e) => {
  const msg = String(e?.message || e);
  if (/ECONNREFUSED|fetch failed|ENOTFOUND/i.test(msg)) {
    console.log(`\n[skip] Ollama not reachable at ${process.env.OLLAMA_HOST || 'http://localhost:11434'} — \`ollama serve\` and retry.`);
    process.exit(0);
  }
  console.error(`\n[error] ${msg}\n`, e.stack);
  process.exit(1);
});
