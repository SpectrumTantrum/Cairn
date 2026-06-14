// Spike: can a local small model survive a 5-STEP AGENT LOOP without falling
// apart? This is the Agent mode of ADR-0005 (Ask/Explain/Synthesize/Recall/
// Plan/Agent) — the highest-risk local-model assumption. Extends
// spikes/ollama/capability.mjs (which only proved a 2-step loop).
//
// CAPABILITY, not latency. This box (18-core/128GB) is NOT the PRD's 8-16GB
// student target, so any timings here are a best-case ceiling. What we care
// about is whether Qwen3-4B / Qwen3-8B can chain ~5 valid tool-calls with
// correct arg types and actually finish the task.
//
// Run (needs `ollama serve`; ideally `ollama pull qwen3:4b qwen3:8b`):
//   npm install && npm start       # auto-runs whichever candidates are installed
//   CHAT_MODELS=qwen3:8b npm start # force a specific model
// With no override the harness probes `ollama list` and runs the installed
// subset of [qwen3:8b, qwen3:4b, llama3.2:3b] (best→worst); absent models get a
// clear "absent → skipped" line. If only the 3B fallback is present the verdict
// is labelled PROVISIONAL (the 4B/8B question stays formally open).
//
// Written as a Node-native TypeScript file (.mts) — Node >=22.6 strips types at
// load with no build step. It has zero runtime deps (built-in `fetch`), so
// `npm install` is a harmless no-op; run it anyway to match the spike workflow.
// Erasable syntax only (annotations/interfaces/as) — no enums/namespaces.

const OLLAMA: string = process.env.OLLAMA || 'http://localhost:11434';
// Candidate chat models, best→worst. The live research question is qwen3:4b vs
// 8b; llama3.2:3b is the always-present fallback (and the cited string-vs-int
// offender — engineering-decisions.md §5 "a 3B model emit `k:"1"` as a string").
// CHAT_MODELS overrides; otherwise we INTERSECT this list with `ollama list` at
// run time so the harness always prints a REAL verdict against what's installed
// rather than skipping everything (the scaffold's old default of qwen3:4b,8b
// skips on a box that only has the 3B).
const CANDIDATES = ['qwen3:8b', 'qwen3:4b', 'llama3.2:3b'];
const MODELS_OVERRIDE: string[] = (process.env.CHAT_MODELS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const MAX_ITERS = 8; // generous cap; the task is designed to need ~5 real steps.
const REQUIRED_STEPS = 5; // PASS gate: a complete run does >= this many valid tool-calls.

// ---------------------------------------------------------------------------
// Fake tools. At least one MUST carry a typed-INTEGER arg (search_notes.k) so
// we can catch "string vs int" schema violations — that is the headline metric
// and there is nothing to catch if every param is a free string.
// ---------------------------------------------------------------------------
interface ToolParam {
  type: string;
  description?: string;
  default?: unknown;
}
interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, ToolParam>;
      required: string[];
    };
  };
}

const tools: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'search_notes',
      description:
        "Search the user's note/PDF vault for relevant chunks. Returns a list of {id, title, snippet}. Use this to discover which notes exist before reading them.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'the search query' },
          k: { type: 'integer', description: 'max number of results (1-20)', default: 8 },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_note',
      description: 'Read the full markdown body of one note by its id (from search_notes results).',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'the note id, e.g. "history/french-rev.md"' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_note',
      description:
        'Create a new note in the vault. Call this LAST, once you have gathered and synthesized the source material.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'vault-relative path for the new note, e.g. "summaries/french-rev.md"' },
          content: { type: 'string', description: 'the full markdown content of the note' },
        },
        required: ['path', 'content'],
      },
    },
  },
];

// Type expected for each tool's args, so we can flag schema violations.
// 'integer' is checked separately from 'string' (the string-vs-int trap).
const argTypes: Record<string, Record<string, string>> = {
  search_notes: { query: 'string', k: 'integer' },
  read_note: { id: 'string' },
  write_note: { path: 'string', content: 'string' },
};

// ---------------------------------------------------------------------------
// Canned vault + fake tool executor. Deterministic so the loop is reproducible.
// The task below is built to require: search -> read -> read (or search) ->
// synthesize -> write_note  (>= 5 steps).
// ---------------------------------------------------------------------------
const VAULT: Record<string, string> = {
  'history/french-rev.md':
    '# French Revolution\nCauses: fiscal crisis from war debt, Enlightenment ideas, food scarcity after the 1788 harvest, Estates-General deadlock.',
  'history/enlightenment.md':
    '# The Enlightenment\nRousseau and Montesquieu attacked absolute monarchy and seeded the ideas of popular sovereignty that fed the Revolution.',
  'history/napoleon.md':
    '# Napoleon\nRose from the Revolution; crowned emperor 1804; the Napoleonic Code spread legal reform across Europe.',
};

function runTool(name: string, args: Record<string, unknown>): string {
  if (name === 'search_notes') {
    const hits = Object.keys(VAULT).map((id) => ({ id, title: VAULT[id].split('\n')[0].replace(/^#\s*/, '') }));
    return JSON.stringify({ results: hits });
  }
  if (name === 'read_note') {
    const id = String(args.id);
    return VAULT[id] ? JSON.stringify({ id, body: VAULT[id] }) : JSON.stringify({ error: `no such note: ${id}` });
  }
  if (name === 'write_note') {
    return JSON.stringify({ ok: true, written: String(args.path), bytes: String(args.content || '').length });
  }
  return JSON.stringify({ error: `unknown tool: ${name}` });
}

// A task that genuinely needs the full chain: 1 search + 3 reads + 1 write = 5 steps.
const SYSTEM =
  'You are an agent operating on the user\'s personal note vault. To answer, you MUST use the tools: ' +
  'first search_notes to find what exists, then read_note to read EACH relevant note, and FINALLY write_note ' +
  'to save your synthesized result. Do not answer from memory. Always pass arguments with the correct JSON types ' +
  '(k must be an integer, not a string).';
const USER =
  'Search my vault for everything about the French Revolution, the Enlightenment, and Napoleon. Read each ' +
  'relevant note, then synthesize a single new note at "summaries/revolution-arc.md" that connects the ' +
  'Enlightenment ideas to the causes of the Revolution and on to Napoleon\'s rise. Save it with write_note.';

// ---------------------------------------------------------------------------
// Ollama OpenAI-compat chat call.
// ---------------------------------------------------------------------------
interface ToolCall {
  id?: string;
  // Ollama's OpenAI-compat endpoint sends `arguments` as a JSON STRING
  // (confirmed empirically), but the OpenAI spec allows an object — validateCall
  // handles both, so type it permissively.
  function?: { name?: string; arguments?: string | Record<string, unknown> };
}
interface ChatChoice {
  message?: { role?: string; content?: string; tool_calls?: ToolCall[] };
}
interface ChatResponse {
  choices?: ChatChoice[];
  error?: unknown;
}

async function chat(model: string, messages: unknown[]): Promise<ChatResponse> {
  const r = await fetch(`${OLLAMA}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, tools, stream: false, temperature: 0 }),
  });
  return r.json() as Promise<ChatResponse>;
}

// ---------------------------------------------------------------------------
// Preflight: do NOT crash if Ollama is down or the model isn't pulled.
// capability.mjs would throw an unhandled rejection here; we skip cleanly with a
// labelled SKIP line so the rest of the table still prints a real verdict.
// ---------------------------------------------------------------------------
async function preflight(model: string): Promise<boolean> {
  try {
    const probe = await chat(model, [{ role: 'user', content: 'reply with "ok"' }]);
    if (probe.error) {
      console.log(`  SKIP: ${model} unavailable (${JSON.stringify(probe.error).slice(0, 80)})`);
      return false;
    }
    return true;
  } catch (e) {
    console.log(
      `  SKIP: cannot reach Ollama at ${OLLAMA} — run \`ollama serve\` + \`ollama pull ${model}\` (${(e as Error).message})`,
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Per-model run metrics.
// ---------------------------------------------------------------------------
interface RunResult {
  model: string;
  ran: boolean;
  validCalls: number; // tool_calls whose name + arg JSON + arg TYPES were all valid
  schemaViolations: number; // bad JSON args, wrong types (string-vs-int), unknown tools, missing required
  completed: boolean; // model called write_note at the end -> task done
  pass: boolean;
  notes: string[];
}

// chatFn is injectable so the happy-path (PASS) branch can be exercised with a
// scripted model in the SELFTEST below — otherwise it's never executed until
// someone pulls qwen3 and re-runs, and a latent completion-path bug would emit a
// silent false FAIL on the exact GO/NO-GO this spike feeds.
type ChatFn = (model: string, messages: unknown[]) => Promise<ChatResponse>;

async function runAgentLoop(model: string, chatFn: ChatFn = chat): Promise<RunResult> {
  const res: RunResult = {
    model,
    ran: true,
    validCalls: 0,
    schemaViolations: 0,
    completed: false,
    pass: false,
    notes: [],
  };

  const messages: unknown[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: USER },
  ];

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    const resp = await chatFn(model, messages);
    const msg = resp.choices?.[0]?.message;
    if (!msg) {
      res.notes.push(`iter ${iter}: empty response (${JSON.stringify(resp.error || resp).slice(0, 80)})`);
      break;
    }
    messages.push(msg);

    const calls = msg.tool_calls || [];
    if (calls.length === 0) {
      // No tool call: the model produced a final text answer (or gave up).
      res.notes.push(`iter ${iter}: no tool call — model said: ${(msg.content || '').slice(0, 80)}`);
      break;
    }

    // A model→tool-call→tool-result cycle is ONE iteration; a parallel batch of
    // N calls still answers all N before the next request (an unanswered
    // tool_call_id corrupts the OpenAI-compat history). We must therefore finish
    // the whole batch even after a completing write_note fires, then break.
    let completedThisBatch = false;
    for (const tc of calls) {
      const name = tc.function?.name || '';
      const rawArgs = tc.function?.arguments ?? '';
      const v = validateCall(name, rawArgs);

      if (v.ok) {
        res.validCalls++;
        const toolResult = runTool(name, v.args);
        messages.push({ role: 'tool', tool_call_id: tc.id || `call_${iter}`, content: toolResult });
        console.log(`    iter ${iter}: OK   ${name}(${argPreview(rawArgs)})`);
        // Completion = a VALID write_note. Mark it; keep answering the rest of
        // the batch, then break out of the loop after the for-of.
        if (name === 'write_note') {
          res.completed = true;
          completedThisBatch = true;
        }
      } else {
        // Schema violation: count it, DON'T run the tool on bad args, feed the
        // failure back as a tool message and let the loop continue. This is the
        // "rejected steps, not corruption" behavior the spec relies on
        // (engineering-decisions.md §5) — a flaky call must not silently corrupt.
        res.schemaViolations++;
        res.notes.push(`iter ${iter}: SCHEMA-VIOLATION ${name}: ${v.reason} — raw=${argPreview(rawArgs)}`);
        messages.push({
          role: 'tool',
          tool_call_id: tc.id || `call_${iter}`,
          content: JSON.stringify({ error: `invalid tool call: ${v.reason}` }),
        });
        console.log(`    iter ${iter}: BAD  ${name}: ${v.reason}`);
      }
    }
    if (completedThisBatch) break;
  }

  if (!res.completed) res.notes.push(`never produced a valid write_note within ${MAX_ITERS} iters`);
  return finalize(res);
}

// ---------------------------------------------------------------------------
// THE load-bearing measurement. Classify a single tool-call as valid or a
// schema violation. Returns the parsed/typed args on success so runTool gets
// clean input. Checks, in order:
//   1. known tool name (search_notes|read_note|write_note) — else violation
//   2. arguments parse cleanly — Ollama's OpenAI-compat endpoint sends a JSON
//      STRING (empirically confirmed) but the spec allows an object; handle both
//   3. every `required` field is present
//   4. each PRESENT field's runtime type matches argTypes[name][field]:
//        'string'  => typeof === 'string'
//        'integer' => typeof === 'number' && Number.isInteger(v)  <-- the
//        string-vs-int trap: a model that emits k:"8" (string) FAILS here.
// Optional fields (e.g. search_notes.k, which has a default and is not in
// `required`) are VALID when omitted; only type-checked when present. Unknown
// EXTRA fields are ignored (not in the README's violation list).
// ---------------------------------------------------------------------------
interface ValidResult {
  ok: boolean;
  reason: string;
  args: Record<string, unknown>;
}

function validateCall(name: string, rawArgs: unknown): ValidResult {
  // 1. known tool
  if (!Object.prototype.hasOwnProperty.call(argTypes, name)) {
    return { ok: false, reason: `unknown tool "${name}"`, args: {} };
  }
  const def = tools.find((t) => t.function.name === name)!.function.parameters;

  // 2. parse args (string from Ollama, or already an object)
  let parsed: Record<string, unknown>;
  if (rawArgs == null || rawArgs === '') {
    parsed = {};
  } else if (typeof rawArgs === 'string') {
    try {
      parsed = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
      return { ok: false, reason: 'arguments are not valid JSON', args: {} };
    }
  } else if (typeof rawArgs === 'object') {
    parsed = rawArgs as Record<string, unknown>;
  } else {
    return { ok: false, reason: `arguments are a bare ${typeof rawArgs}, not an object`, args: {} };
  }

  // 3. required fields present
  for (const reqField of def.required) {
    if (!(reqField in parsed) || parsed[reqField] === undefined || parsed[reqField] === null) {
      return { ok: false, reason: `missing required field "${reqField}"`, args: parsed };
    }
  }

  // 4. type-check each PRESENT declared field
  const expected = argTypes[name];
  for (const field of Object.keys(expected)) {
    if (!(field in parsed) || parsed[field] === undefined) continue; // omitted optional -> ok
    const val = parsed[field];
    const want = expected[field];
    if (want === 'string') {
      if (typeof val !== 'string') {
        return { ok: false, reason: `field "${field}" must be string, got ${describe(val)}`, args: parsed };
      }
    } else if (want === 'integer') {
      // THE trap: k:"8" (a string) and k:8.5 both fail; only a real integer passes.
      if (typeof val !== 'number' || !Number.isInteger(val)) {
        return { ok: false, reason: `field "${field}" must be integer, got ${describe(val)}`, args: parsed };
      }
    }
  }

  return { ok: true, reason: '', args: parsed };
}

function describe(v: unknown): string {
  if (typeof v === 'string') return `string ${JSON.stringify(v)}`;
  if (typeof v === 'number') return `number ${v}`;
  return `${typeof v} ${JSON.stringify(v)}`;
}

function argPreview(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
  return (s || '').slice(0, 80);
}

function finalize(res: RunResult): RunResult {
  // PASS = >= REQUIRED_STEPS valid tool-calls AND zero schema violations AND a
  // valid write_note completed the run. All three are necessary.
  res.pass = res.validCalls >= REQUIRED_STEPS && res.schemaViolations === 0 && res.completed;
  return res;
}

// ---------------------------------------------------------------------------
// Resolve which chat models to run. Explicit CHAT_MODELS wins. Otherwise probe
// `ollama list` (/api/tags) and intersect with CANDIDATES so we run whatever is
// actually installed (in best→worst order) and print an honest "absent" line
// for the rest — instead of the scaffold's old default that skipped everything.
// ---------------------------------------------------------------------------
async function listInstalled(): Promise<string[] | null> {
  try {
    const r = await fetch(`${OLLAMA}/api/tags`);
    const j = (await r.json()) as { models?: { name?: string }[] };
    return (j.models || []).map((m) => m.name || '').filter(Boolean);
  } catch {
    return null;
  }
}

async function resolveModels(): Promise<{ run: string[]; absent: string[] }> {
  if (MODELS_OVERRIDE.length) return { run: MODELS_OVERRIDE, absent: [] };
  const installed = await listInstalled();
  if (installed == null) {
    // Ollama unreachable — return the full candidate list; preflight will skip
    // each with a clear message rather than us guessing here.
    return { run: CANDIDATES, absent: [] };
  }
  const has = (m: string) => installed.includes(m) || installed.includes(`${m}:latest`);
  const run = CANDIDATES.filter(has);
  const absent = CANDIDATES.filter((m) => !has(m));
  // If none of the named candidates are installed, fall back to running them all
  // anyway so preflight produces an explicit per-model skip line.
  return { run: run.length ? run : CANDIDATES, absent: run.length ? absent : [] };
}

// ---------------------------------------------------------------------------
// SELFTEST (SELFTEST=1 npm start): exercise the PASS/completion branch with a
// scripted model that runs the perfect chain (search → 3×read → write_note).
// No real run reaches PASS on a small model, so without this the positive wiring
// (validCalls→5, completed on write_note, the break, finalize→pass) is never
// executed. Also re-checks the integer-trap FAIL via a scripted bad call.
// ---------------------------------------------------------------------------
function scripted(seq: ToolCall[][]): ChatFn {
  let i = 0;
  return async () => {
    const calls = seq[i++];
    if (!calls) return { choices: [{ message: { role: 'assistant', content: 'done.' } }] };
    return { choices: [{ message: { role: 'assistant', content: '', tool_calls: calls } }] };
  };
}
function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `c${Math.random().toString(36).slice(2, 8)}`, function: { name, arguments: JSON.stringify(args) } };
}

if (process.env.SELFTEST) {
  console.log('== SELFTEST: scripted chains (no Ollama needed) ==');
  let fails = 0;
  const assert = (label: string, cond: boolean) => {
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
    if (!cond) fails++;
  };

  // 1. Happy path: exactly the 5-call chain the task is designed to need.
  const happy = scripted([
    [call('search_notes', { query: 'revolution', k: 8 })],
    [call('read_note', { id: 'history/french-rev.md' })],
    [call('read_note', { id: 'history/enlightenment.md' })],
    [call('read_note', { id: 'history/napoleon.md' })],
    [call('write_note', { path: 'summaries/revolution-arc.md', content: '# arc\nlinked.' })],
  ]);
  const r1 = await runAgentLoop('SCRIPTED-happy', happy);
  assert('happy: 5 valid calls', r1.validCalls === 5);
  assert('happy: 0 schema violations', r1.schemaViolations === 0);
  assert('happy: completed (write_note fired)', r1.completed === true);
  assert('happy: PASS=true', r1.pass === true);

  // 2. The string-vs-int trap mid-chain → must FAIL (1 violation, no PASS).
  const trap = scripted([
    [call('search_notes', { query: 'revolution', k: '8' })], // k as STRING
    [call('read_note', { id: 'history/french-rev.md' })],
    [call('write_note', { path: 'summaries/x.md', content: 'hi' })],
  ]);
  const r2 = await runAgentLoop('SCRIPTED-trap', trap);
  assert('trap: 1 schema violation (k:"8")', r2.schemaViolations === 1);
  assert('trap: PASS=false', r2.pass === false);

  // 3. Completes but with too few valid calls → PASS=false (gate needs ≥5).
  const short = scripted([
    [call('search_notes', { query: 'x', k: 5 })],
    [call('write_note', { path: 'a.md', content: 'b' })],
  ]);
  const r3 = await runAgentLoop('SCRIPTED-short', short);
  assert('short: completed but only 2 valid calls', r3.completed === true && r3.validCalls === 2);
  assert('short: PASS=false (< 5 valid calls)', r3.pass === false);

  console.log(`\n${fails === 0 ? 'SELFTEST OK — verdict path verified end-to-end' : fails + ' SELFTEST ASSERTIONS FAILED'}`);
  process.exit(fails === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Driver.
// ---------------------------------------------------------------------------
console.log('== Agent-loop spike: 5-step tool-calling survival (Qwen3-4B vs 8B) ==');
const { run: MODELS, absent: ABSENT } = await resolveModels();
console.log(`ollama=${OLLAMA}  required_steps=${REQUIRED_STEPS}  max_iters=${MAX_ITERS}`);
console.log(`candidates=${CANDIDATES.join(', ')}`);
console.log(`running=${MODELS.join(', ') || '(none)'}`);
if (ABSENT.length) console.log(`absent (not in \`ollama list\`, skipped)=${ABSENT.join(', ')}`);
console.log('NOTE: capability not latency; this box is not the 8-16GB student target.\n');

const results: RunResult[] = [];

// Record the absent candidates up front so the table shows the full picture.
for (const model of ABSENT) {
  results.push({
    model,
    ran: false,
    validCalls: 0,
    schemaViolations: 0,
    completed: false,
    pass: false,
    notes: ['absent — not installed (run `ollama pull ' + model + '` to test this tier)'],
  });
}

for (const model of MODELS) {
  console.log(`-- ${model} --`);
  const ok = await preflight(model);
  if (!ok) {
    results.push({ model, ran: false, validCalls: 0, schemaViolations: 0, completed: false, pass: false, notes: ['skipped (preflight failed)'] });
    continue;
  }
  const r = await runAgentLoop(model);
  results.push(r);
  console.log(
    `   valid_calls=${r.validCalls}  schema_violations=${r.schemaViolations}  completed=${r.completed}  PASS=${r.pass}`,
  );
  if (r.notes.length) r.notes.forEach((n) => console.log(`     · ${n}`));
}

console.log('\n== SUMMARY (per-model PASS/FAIL) ==');
const pad = (s: string, n: number) => (s + ' '.repeat(n)).slice(0, n);
console.log(
  `${pad('model', 16)}${pad('ran', 6)}${pad('valid_calls', 13)}${pad('schema_viol', 13)}${pad('completed', 11)}VERDICT`,
);
for (const r of results) {
  const verdict = !r.ran ? 'SKIP' : r.pass ? 'PASS' : 'FAIL';
  console.log(
    `${pad(r.model, 16)}${pad(String(r.ran), 6)}${pad(String(r.validCalls), 13)}${pad(String(r.schemaViolations), 13)}${pad(String(r.completed), 11)}${verdict}`,
  );
}

console.log(
  `\nPASS criterion: valid_calls >= ${REQUIRED_STEPS} AND schema_violations == 0 AND completed (valid write_note).`,
);

// Overall verdict line for the spike's research question (4B vs 8B). If only the
// 3B fallback ran, the headline 4B/8B question is formally unanswered → PROVISIONAL.
const ran = results.filter((r) => r.ran);
const passed = ran.filter((r) => r.pass).map((r) => r.model);
const failed = ran.filter((r) => !r.pass).map((r) => r.model);
const testedTargetTier = ran.some((r) => r.model.startsWith('qwen3:'));
const tag = testedTargetTier ? '' : 'PROVISIONAL (target tier qwen3:4b/8b not installed; ran fallback only) — ';
if (ran.length === 0) {
  console.log('\nVERDICT: NO-RUN — no chat model was reachable; cannot answer the spike question.');
} else {
  console.log(
    `\nVERDICT: ${tag}${passed.length} PASS [${passed.join(', ') || '-'}], ${failed.length} FAIL [${failed.join(', ') || '-'}] of ${ran.length} model(s) run.`,
  );
}
