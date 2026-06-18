// IR metrics (BEIR conventions) + RRF fusion + query->gold lexical-overlap measure.
// nDCG uses linear gain with a log2(rank+1) discount, matching pytrec_eval's
// ndcg_cut (what BEIR reports), so our numbers line up with published baselines.

export function successAtK(rankedIds, relSet, k) {
  for (let i = 0; i < Math.min(k, rankedIds.length); i++) if (relSet.has(rankedIds[i])) return 1;
  return 0;
}

export function recallAtK(rankedIds, relSet, k) {
  if (relSet.size === 0) return 0;
  let hit = 0;
  for (let i = 0; i < Math.min(k, rankedIds.length); i++) if (relSet.has(rankedIds[i])) hit++;
  return hit / relSet.size;
}

export function mrrAtK(rankedIds, relSet, k) {
  for (let i = 0; i < Math.min(k, rankedIds.length); i++) if (relSet.has(rankedIds[i])) return 1 / (i + 1);
  return 0;
}

export function ndcgAtK(rankedIds, relGrades, k) {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, rankedIds.length); i++) {
    const g = relGrades.get(rankedIds[i]) || 0;
    if (g > 0) dcg += g / Math.log2(i + 2);
  }
  const ideal = [...relGrades.values()].sort((a, b) => b - a);
  let idcg = 0;
  for (let i = 0; i < Math.min(k, ideal.length); i++) idcg += ideal[i] / Math.log2(i + 2);
  return idcg > 0 ? dcg / idcg : 0;
}

// Reciprocal Rank Fusion over already-sorted rankings (K=60, 1-based ranks).
export function rrf(rankings, { k = 60, P = 100 } = {}) {
  const score = new Map();
  for (const ranking of rankings) {
    for (let r = 0; r < ranking.length; r++) {
      const id = ranking[r].id;
      score.set(id, (score.get(id) || 0) + 1 / (k + r + 1));
    }
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, P).map(([id, s]) => ({ id, score: s }));
}

// Fraction of (stemmed, stopword-free) query tokens that also appear in the union
// of the gold documents' tokens. Low coverage => the answer is NOT lexically findable
// from the query words => a fair test of semantic matching.
export function overlapCoverage(qTokens, goldTokenSet) {
  const q = new Set(qTokens);
  if (q.size === 0) return 0;
  let hit = 0;
  for (const t of q) if (goldTokenSet.has(t)) hit++;
  return hit / q.size;
}
