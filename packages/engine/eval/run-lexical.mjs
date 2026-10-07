// Product gate: score production search(..., { mode: "lexical" }) on a clean vault.
// Gold is (file, heading). No Ollama required.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { successAtK, recallAtK, mrrAtK, ndcgAtK, overlapCoverage } from '../../../spikes/rag-quality-v2/lib/metrics.mjs';
import { tokenize } from '../../../spikes/rag-quality-v2/lib/text.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = join(HERE, '..');
const VAULT_ROOT = join(HERE, 'vault');
const SPIKE_METRICS = join(HERE, '../../../spikes/rag-quality-v2/lib/metrics.mjs');

/** Paraphrase items must stay below leak-fixture overlap (not HIGH vs gold). */
const PARAPHRASE_MAX_OVERLAP = 0.35;

/** Smoke pass: harness completes and at least one exact-term query hits gold in top 3. */
const SMOKE_EXACT_TERM_HIT_AT_3 = 1;

const KS = [3, 8];

function ensureBuilt() {
  const r = spawnSync('npm', ['run', 'build'], { cwd: ENGINE_ROOT, stdio: 'inherit', shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function loadQueries() {
  const raw = JSON.parse(readFileSync(join(HERE, 'queries.json'), 'utf8'));
  return raw.queries;
}

function listChunks(index) {
  const n = Number(index.getMeta('chunks') ?? '0');
  const out = [];
  for (let id = 1; id <= n; id++) {
    const c = index.getChunk(id);
    if (c) out.push(c);
  }
  return out;
}

function relIdsForGold(chunks, gold) {
  const ids = new Set();
  for (const c of chunks) {
    if (c.file === gold.file && c.heading === gold.heading) ids.add(c.id);
  }
  return ids;
}

function goldTokenSet(chunks, gold) {
  const tokens = new Set();
  for (const c of chunks) {
    if (c.file === gold.file && c.heading === gold.heading) {
      for (const t of tokenize(c.text)) tokens.add(t);
    }
  }
  return tokens;
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function aggregateMetrics(perQuery) {
  const byCat = new Map();
  for (const row of perQuery) {
    if (!byCat.has(row.category)) byCat.set(row.category, []);
    byCat.get(row.category).push(row);
  }
  const cats = [...byCat.keys()].sort();
  const rows = [];
  for (const cat of ['exact-term', 'paraphrase', 'fts-miss', ...cats.filter((c) => !['exact-term', 'paraphrase', 'fts-miss'].includes(c))]) {
    if (!byCat.has(cat)) continue;
    const items = byCat.get(cat);
    for (const k of KS) {
      rows.push({
        category: cat,
        k,
        success: mean(items.map((r) => r[`success@${k}`])),
        recall: mean(items.map((r) => r[`recall@${k}`])),
        mrr: mean(items.map((r) => r[`mrr@${k}`])),
        ndcg: mean(items.map((r) => r[`ndcg@${k}`])),
        n: items.length,
      });
    }
  }
  for (const k of KS) {
    rows.push({
      category: 'ALL',
      k,
      success: mean(perQuery.map((r) => r[`success@${k}`])),
      recall: mean(perQuery.map((r) => r[`recall@${k}`])),
      mrr: mean(perQuery.map((r) => r[`mrr@${k}`])),
      ndcg: mean(perQuery.map((r) => r[`ndcg@${k}`])),
      n: perQuery.length,
    });
  }
  return rows;
}

function printTable(rows) {
  console.log('\nlexical retrieval (production search, mode=lexical)\n');
  console.log('category        k   n   success  recall    mrr    nDCG');
  for (const r of rows) {
    console.log(
      `  ${r.category.padEnd(14)} ${String(r.k).padStart(2)}  ${String(r.n).padStart(2)}   ` +
        `${(r.success * 100).toFixed(1).padStart(5)}%  ${(r.recall * 100).toFixed(1).padStart(5)}%  ` +
        `${r.mrr.toFixed(3).padStart(5)}  ${r.ndcg.toFixed(3).padStart(5)}`,
    );
  }
}

async function main() {
  readFileSync(SPIKE_METRICS); // fail fast if spike path missing

  ensureBuilt();
  const { indexVault, openIndex, search } = await import(join(ENGINE_ROOT, 'dist/index.js'));

  const stats = await indexVault(VAULT_ROOT, { lexical: true });
  const index = openIndex(VAULT_ROOT);
  const chunks = listChunks(index);
  const queries = loadQueries();

  console.log(`indexed eval vault: ${stats.files} files, ${stats.chunks} chunks (mode=${stats.mode})`);

  const perQuery = [];
  let paraphraseOk = true;

  for (const q of queries) {
    const rel = relIdsForGold(chunks, q.gold);
    if (rel.size === 0) {
      console.error(`no chunks for gold ${q.gold.file} › ${q.gold.heading} (query ${q.id})`);
      index.close();
      process.exit(1);
    }

    if (q.category === 'paraphrase') {
      const goldSet = goldTokenSet(chunks, q.gold);
      const cov = overlapCoverage(tokenize(q.question), goldSet);
      const ok = cov < PARAPHRASE_MAX_OVERLAP;
      if (!ok) {
        paraphraseOk = false;
        console.error(
          `paraphrase ${q.id} overlap ${cov.toFixed(3)} ≥ ${PARAPHRASE_MAX_OVERLAP} (too HIGH vs gold; rewrite query)`,
        );
      }
    }

    const { hits, mode } = await search(index, q.question, { mode: 'lexical', k: 8, pool: 64 });
    if (mode !== 'lexical') {
      console.error(`expected lexical mode, got ${mode} for ${q.id}`);
      index.close();
      process.exit(1);
    }

    const rankedIds = hits.map((h) => {
      const row = chunks.find((c) => c.file === h.file && c.heading === h.heading && c.line === h.line);
      return row?.id ?? -1;
    }).filter((id) => id > 0);

    const relGrades = new Map([...rel].map((id) => [id, 1]));
    const row = { id: q.id, category: q.category };
    for (const k of KS) {
      row[`success@${k}`] = successAtK(rankedIds, rel, k);
      row[`recall@${k}`] = recallAtK(rankedIds, rel, k);
      row[`mrr@${k}`] = mrrAtK(rankedIds, rel, k);
      row[`ndcg@${k}`] = ndcgAtK(rankedIds, relGrades, k);
    }
    perQuery.push(row);
  }

  index.close();

  if (!paraphraseOk) {
    console.error('\nFAIL — paraphrase queries must stay below overlap ceiling (see README)');
    process.exit(1);
  }

  printTable(aggregateMetrics(perQuery));

  const exactHits = perQuery.filter((r) => r.category === 'exact-term' && r['success@3'] === 1).length;
  const smokeOk = exactHits >= SMOKE_EXACT_TERM_HIT_AT_3;

  console.log('\nsmoke bar:');
  console.log(
    `  ${smokeOk ? '✓' : '✗'} exact-term success@3 ≥ ${SMOKE_EXACT_TERM_HIT_AT_3} (got ${exactHits})`,
  );
  console.log('  ✓ harness completed (index + lexical search)');

  console.log(`\n${smokeOk ? 'PASS' : 'FAIL'} — eval:lexical smoke`);
  process.exit(smokeOk ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
