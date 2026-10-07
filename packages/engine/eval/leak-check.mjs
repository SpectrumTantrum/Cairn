// Negative-control gate: confirms the rag-quality fixture eval is still lexically leaky
// on paraphrase items (overlapCoverage floors). Does not call Ollama or production search().
import { accessSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildChunks } from '../../../spikes/rag-quality/chunker.mjs';
import { EVAL } from '../../../spikes/rag-quality/evals.mjs';
import { tokenize } from '../../../spikes/rag-quality-v2/lib/text.mjs';
import { overlapCoverage } from '../../../spikes/rag-quality-v2/lib/metrics.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPIKE_ROOT = join(HERE, '../../../spikes');

const LEAK_MEDIAN_FLOOR = 0.35;
const LEAK_MEAN_FLOOR = 0.35;
const LEAK_FRAC_AT_025 = 0.70;
const OVERLAP_BUCKET = 0.25;

function assertSpikePaths() {
  const required = [
    join(SPIKE_ROOT, 'rag-quality/chunker.mjs'),
    join(SPIKE_ROOT, 'rag-quality/evals.mjs'),
    join(SPIKE_ROOT, 'rag-quality-v2/lib/text.mjs'),
    join(SPIKE_ROOT, 'rag-quality-v2/lib/metrics.mjs'),
  ];
  for (const p of required) {
    accessSync(p);
  }
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function summarize(overlaps) {
  const fracAt025 =
    overlaps.length === 0 ? 0 : overlaps.filter((v) => v >= OVERLAP_BUCKET).length / overlaps.length;
  return {
    n: overlaps.length,
    median: median(overlaps),
    mean: mean(overlaps),
    fracAt025,
  };
}

function main() {
  assertSpikePaths();

  const chunks = buildChunks();
  const byId = new Map(chunks.map((c) => [c.id, c]));

  for (const { expected_chunk_id } of EVAL) {
    if (!byId.has(expected_chunk_id)) {
      console.error(`missing expected_chunk_id=${expected_chunk_id} in chunk manifest`);
      process.exit(1);
    }
  }

  const byCategory = new Map();
  for (const item of EVAL) {
    const chunk = byId.get(item.expected_chunk_id);
    const goldSet = new Set(tokenize(chunk.text));
    const cov = overlapCoverage(tokenize(item.question), goldSet);
    if (!byCategory.has(item.category)) byCategory.set(item.category, []);
    byCategory.get(item.category).push(cov);
  }

  const order = ['paraphrase', 'exact-term', 'multi-hop'];
  const categories = [...new Set([...order, ...byCategory.keys()])].filter((c) => byCategory.has(c));

  console.log('query→gold lexical overlap (overlapCoverage) — rag-quality fixture negative control\n');
  console.log(
    'category       n   median   mean   frac≥0.25',
  );
  for (const cat of categories) {
    const { n, median: med, mean: mn, fracAt025 } = summarize(byCategory.get(cat));
    console.log(
      `  ${cat.padEnd(12)} ${String(n).padStart(3)}   ${med.toFixed(3).padStart(6)} ${mn.toFixed(3).padStart(6)}   ${(fracAt025 * 100).toFixed(1).padStart(5)}%`,
    );
  }

  const para = summarize(byCategory.get('paraphrase') || []);
  const gates = [
    ['paraphrase median', para.median, LEAK_MEDIAN_FLOOR],
    ['paraphrase mean', para.mean, LEAK_MEAN_FLOOR],
    ['paraphrase frac≥0.25', para.fracAt025, LEAK_FRAC_AT_025],
  ];

  console.log('\nparaphrase gates (fixture still lexically leaky):');
  let pass = true;
  for (const [label, value, floor] of gates) {
    const ok = value >= floor;
    if (!ok) pass = false;
    const fmt = label.includes('frac') ? `${(value * 100).toFixed(1)}%` : value.toFixed(3);
    const floorFmt = label.includes('frac') ? `${(floor * 100).toFixed(0)}%` : floor.toFixed(2);
    console.log(`  ${ok ? '✓' : '✗'} ${label}: ${fmt}  (floor ${floorFmt})`);
  }

  console.log(`\n${pass ? 'PASS' : 'FAIL'} — paraphrase overlap negative control`);
  process.exit(pass ? 0 : 1);
}

main();
