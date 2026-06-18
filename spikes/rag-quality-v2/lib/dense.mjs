// Dense retrieval via Ollama /api/embed, with an on-disk vector cache so re-runs
// (and metric iteration) don't re-embed. Vectors are unit-normalized, so a dot
// product IS cosine similarity.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const OLLAMA = process.env.OLLAMA_HOST || 'http://localhost:11434';
const BATCH = Number(process.env.EMBED_BATCH || 64);

async function embedBatch(model, inputs) {
  const r = await fetch(`${OLLAMA}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: inputs }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} from /api/embed: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  const j = await r.json();
  if (!j.embeddings) throw new Error('no embeddings in response');
  return j.embeddings;
}

export async function loadOrEmbed(model, texts, cacheFile, label = '') {
  if (existsSync(cacheFile)) {
    const c = JSON.parse(readFileSync(cacheFile, 'utf8'));
    if (c.model === model && c.vectors?.length === texts.length) {
      console.log(`  [cache] ${label}: ${texts.length} vectors (dim=${c.dim})`);
      return c.vectors;
    }
  }
  const vectors = [];
  const t0 = Date.now();
  for (let i = 0; i < texts.length; i += BATCH) {
    const vecs = await embedBatch(model, texts.slice(i, i + BATCH));
    for (const v of vecs) vectors.push(v);
    process.stdout.write(`\r  [embed] ${label}: ${Math.min(i + BATCH, texts.length)}/${texts.length}`);
  }
  process.stdout.write('\n');
  const dim = vectors[0]?.length || 0;
  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, JSON.stringify({ model, dim, vectors }));
  console.log(`  [embed] ${label}: done in ${((Date.now() - t0) / 1000).toFixed(1)}s (dim=${dim})`);
  return vectors;
}

export function normalizeRows(vectors) {
  return vectors.map((v) => {
    let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i];
    n = Math.sqrt(n) || 1;
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
    return out;
  });
}

export function rankDense(qVec, docVecs, ids, P = 100) {
  const arr = new Array(docVecs.length);
  for (let i = 0; i < docVecs.length; i++) {
    const d = docVecs[i]; let s = 0;
    for (let k = 0; k < d.length; k++) s += d[k] * qVec[k];
    arr[i] = [i, s];
  }
  arr.sort((a, b) => b[1] - a[1]);
  return arr.slice(0, P).map(([i, s]) => ({ id: ids[i], score: s }));
}
