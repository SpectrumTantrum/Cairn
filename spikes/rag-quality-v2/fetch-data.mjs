// Downloads the BEIR datasets this spike evaluates on (SciFact, NFCorpus) into ./data/.
// Datasets are NOT committed (see .gitignore) — run `npm run fetch` after cloning.
// Source: the canonical BEIR distribution (TU Darmstadt / Nandan Thakur, MIT-licensed tooling).
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');
const BASE = 'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets';
const SETS = ['scifact', 'nfcorpus'];

mkdirSync(DATA, { recursive: true });
for (const name of SETS) {
  if (existsSync(join(DATA, name, 'corpus.jsonl'))) { console.log(`[skip] ${name} already present`); continue; }
  const zip = join(DATA, `${name}.zip`);
  console.log(`[fetch] ${name} ...`);
  execFileSync('curl', ['-sSL', '--fail', '-o', zip, `${BASE}/${name}.zip`], { stdio: 'inherit' });
  execFileSync('unzip', ['-oq', zip, '-d', DATA], { stdio: 'inherit' });
  console.log(`[ok] ${name}`);
}
console.log('done.');
