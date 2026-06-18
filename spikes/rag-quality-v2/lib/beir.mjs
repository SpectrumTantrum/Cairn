// Loads a BEIR-format dataset (corpus.jsonl, queries.jsonl, qrels/test.tsv).
// Evaluation is on the TEST split: queries = exactly those that appear in test qrels.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadDataset(dataRoot, name) {
  const dir = join(dataRoot, name);

  const corpus = new Map();
  for (const line of readFileSync(join(dir, 'corpus.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const d = JSON.parse(line);
    corpus.set(String(d._id), { title: d.title || '', text: d.text || '' });
  }

  const allQueries = new Map();
  for (const line of readFileSync(join(dir, 'queries.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const q = JSON.parse(line);
    allQueries.set(String(q._id), q.text || '');
  }

  const qrels = new Map(); // qid -> Map(docId -> grade)
  const tsv = readFileSync(join(dir, 'qrels', 'test.tsv'), 'utf8').split('\n');
  for (let i = 1; i < tsv.length; i++) { // row 0 is the header
    const line = tsv[i]; if (!line.trim()) continue;
    const [qid, did, score] = line.split('\t');
    const g = Number(score);
    if (!(g > 0)) continue;
    if (!qrels.has(qid)) qrels.set(qid, new Map());
    qrels.get(qid).set(String(did), g);
  }

  const queries = new Map();
  for (const qid of qrels.keys()) if (allQueries.has(qid)) queries.set(qid, allQueries.get(qid));

  return { corpus, queries, qrels };
}
