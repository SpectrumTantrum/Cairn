// Spike: Ollama CAPABILITY (not latency — this box is 18-core/128GB, NOT the
// PRD's 8-16GB student target, so timings here are a best-case ceiling only).
// Tests: (1) embed round-trip + a tiny retrieval-ranking sanity check;
// (2) the genuinely high-risk assumption — local small-model tool-calling
// reliability over multiple trials, incl. a 2-step tool loop.
const OLLAMA = 'http://localhost:11434';
const EMBED_MODEL = 'nomic-embed-text';
const CHAT_MODEL = process.env.CHAT_MODEL || 'llama3.2:3b';

function cos(a, b) { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na) * Math.sqrt(nb)); }

async function embed(input) {
  const r = await fetch(`${OLLAMA}/api/embed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: EMBED_MODEL, input }) });
  const j = await r.json();
  return j.embeddings;
}

console.log('== (1) EMBED round-trip + retrieval ranking sanity ==');
const t0 = Date.now();
const docs = [
  'Photosynthesis converts light energy into chemical energy in plant chloroplasts.',
  'The mitochondria is the powerhouse of the cell, producing ATP via respiration.',
  'Quicksort is a divide-and-conquer sorting algorithm with O(n log n) average time.',
];
const query = 'How do plants make energy from sunlight?';
const all = await embed([query, ...docs]);
const dt = Date.now() - t0;
console.log(`embed dim = ${all[0].length} (expect 768)  | ${all.length} texts in ${dt}ms on THIS machine`);
const sims = docs.map((d, i) => ({ d: d.slice(0, 40), sim: +cos(all[0], all[i + 1]).toFixed(3) })).sort((a, b) => b.sim - a.sim);
console.log('query:', query);
sims.forEach((s, i) => console.log(`  ${i === 0 ? '>>' : '  '} ${s.sim}  ${s.d}...`));
console.log('top hit is the photosynthesis doc?', sims[0].d.startsWith('Photosynthesis'));

console.log('\n== (2) TOOL-CALLING reliability (OpenAI-compat /v1) ==');
const tools = [{
  type: 'function',
  function: {
    name: 'search_notes',
    description: "Search the user's personal notes/PDF vault for relevant chunks. Use this for ANY question about the user's own materials.",
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'the search query' }, k: { type: 'integer', description: 'number of results', default: 8 } }, required: ['query'] },
  },
}];

async function chat(messages, useTools = true) {
  const r = await fetch(`${OLLAMA}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: CHAT_MODEL, messages, tools: useTools ? tools : undefined, stream: false, temperature: 0 }),
  });
  return r.json();
}

const TRIALS = 5;
let validCalls = 0, validArgs = 0;
const prompt = 'What did my lecture notes say about the French Revolution causes?';
for (let i = 0; i < TRIALS; i++) {
  const j = await chat([
    { role: 'system', content: 'You answer ONLY from the user vault. Always call search_notes first before answering questions about their notes.' },
    { role: 'user', content: prompt },
  ]);
  const tc = j.choices?.[0]?.message?.tool_calls?.[0];
  if (tc && tc.function?.name === 'search_notes') {
    validCalls++;
    try { const args = JSON.parse(tc.function.arguments); if (typeof args.query === 'string' && args.query.length) validArgs++; } catch {}
  }
  process.stdout.write(`  trial ${i + 1}: ${tc ? `called ${tc.function.name}(${tc.function.arguments})` : 'NO TOOL CALL (' + (j.choices?.[0]?.message?.content || j.error || '???').slice(0, 60) + ')'}\n`);
}
console.log(`tool-call rate: ${validCalls}/${TRIALS}  | valid JSON args: ${validArgs}/${TRIALS}`);

console.log('\n== (2b) 2-STEP tool loop (call -> feed result -> final answer) ==');
const msgs = [
  { role: 'system', content: 'Answer only from search_notes results. Cite nothing you did not retrieve.' },
  { role: 'user', content: prompt },
];
const step1 = await chat(msgs);
const call = step1.choices?.[0]?.message?.tool_calls?.[0];
if (call) {
  msgs.push(step1.choices[0].message);
  msgs.push({ role: 'tool', tool_call_id: call.id || 'call_0', content: 'RESULT: "Causes of the French Revolution: fiscal crisis, Enlightenment ideas, food scarcity (1788 harvest), Estates-General deadlock." [[cite:history/french-rev.md#causes]]' });
  const step2 = await chat(msgs, false);
  const final = step2.choices?.[0]?.message?.content || '(none)';
  console.log('  step2 final answer used the tool result?', /fiscal|enlightenment|harvest|estates/i.test(final));
  console.log('  answer:', final.slice(0, 200).replace(/\n/g, ' '));
} else {
  console.log('  no tool call at step 1 -> loop cannot proceed');
}
