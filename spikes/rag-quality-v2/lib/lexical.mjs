// TF-IDF (cosine) and BM25 over a tokenized corpus, sharing one inverted index.
// BM25 params follow the Anserini/BEIR defaults (k1=0.9, b=0.4) so our numbers are
// directly comparable to published BM25 baselines — the harness validity anchor.
const K1 = 0.9, B = 0.4;

export function buildLexical(docs) {
  // docs: [{ id, tokens: string[] }]
  const N = docs.length;
  const ids = docs.map((d) => d.id);
  const docLen = new Array(N);
  const postings = new Map(); // term -> [[docIdx, tf], ...]
  const df = new Map();

  for (let i = 0; i < N; i++) {
    const toks = docs[i].tokens;
    docLen[i] = toks.length;
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, c] of tf) {
      if (!postings.has(t)) { postings.set(t, []); df.set(t, 0); }
      postings.get(t).push([i, c]);
      df.set(t, df.get(t) + 1);
    }
  }

  const avgdl = docLen.reduce((a, b) => a + b, 0) / Math.max(1, N);
  const idfBM = new Map(), idfTF = new Map();
  for (const [t, d] of df) {
    idfBM.set(t, Math.log(1 + (N - d + 0.5) / (d + 0.5)));
    idfTF.set(t, Math.log(N / d));
  }

  // Precompute doc vector norms for TF-IDF cosine.
  const docNorm = new Array(N).fill(0);
  for (const [t, plist] of postings) {
    const idf = idfTF.get(t);
    for (const [i, c] of plist) { const w = (1 + Math.log(c)) * idf; docNorm[i] += w * w; }
  }
  for (let i = 0; i < N; i++) docNorm[i] = Math.sqrt(docNorm[i]) || 1;

  function rankBM25(qTokens, P = 100) {
    const score = new Map();
    for (const t of new Set(qTokens)) {
      const plist = postings.get(t); if (!plist) continue;
      const idf = idfBM.get(t);
      for (const [i, tf] of plist) {
        const s = idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * docLen[i] / avgdl));
        score.set(i, (score.get(i) || 0) + s);
      }
    }
    return topP(score, ids, P);
  }

  function rankTFIDF(qTokens, P = 100) {
    const qtf = new Map();
    for (const t of qTokens) qtf.set(t, (qtf.get(t) || 0) + 1);
    const qw = new Map(); let qNorm = 0;
    for (const [t, c] of qtf) {
      const idf = idfTF.get(t); if (idf === undefined) continue;
      const w = (1 + Math.log(c)) * idf; qw.set(t, w); qNorm += w * w;
    }
    qNorm = Math.sqrt(qNorm) || 1;
    const score = new Map();
    for (const [t, wq] of qw) {
      const plist = postings.get(t); if (!plist) continue;
      const idf = idfTF.get(t);
      for (const [i, tf] of plist) { const wd = (1 + Math.log(tf)) * idf; score.set(i, (score.get(i) || 0) + wq * wd); }
    }
    for (const [i, s] of score) score.set(i, s / (docNorm[i] * qNorm));
    return topP(score, ids, P);
  }

  return { rankBM25, rankTFIDF, avgdl, N };
}

function topP(scoreMap, ids, P) {
  const arr = [...scoreMap.entries()];
  arr.sort((a, b) => b[1] - a[1]);
  return arr.slice(0, P).map(([i, s]) => ({ id: ids[i], score: s }));
}
