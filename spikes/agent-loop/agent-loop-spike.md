# Spike: can a local model survive a 5-step Agent loop?

**Question.** Cairn's **Agent** mode (ADR-0005) needs a local model to chain
several tool-calls — search the vault, read notes, synthesize, write a note —
without losing the plot or corrupting its tool arguments. The `spikes/ollama`
capability spike only proved a **2-step** loop. This spike asks the harder
question: **does Qwen3-4B / Qwen3-8B survive ~5 chained steps?**

**What it does.** Runs an Ollama (OpenAI-compat `/v1/chat/completions`)
tool-calling loop with three fake tools — `search_notes` (has a typed-`integer`
arg `k`, the string-vs-int trap), `read_note`, `write_note` — over a canned
3-note vault. The task is written so a correct run *needs* the full chain:
`search_notes → read_note → read_note → read_note → write_note` (5 valid
tool-calls — 1 search, 3 reads, 1 write). For each model it counts **valid tool-calls**,
**schema violations** (bad-JSON args, wrong arg types such as `k:"8"` instead of
`k:8`, unknown tools, missing required fields), and whether the run **completes**
(ends in a valid `write_note`).

**Capability, not latency.** Like the sibling spikes, the dev box is not the
PRD's 8–16 GB student target; any timing is a best-case ceiling. Only the
call-validity / completion behavior is the signal.

## Run

Needs a local Ollama (`ollama serve`). It auto-detects which chat models are
installed — no model is mandatory, but the **target tier is `qwen3:4b` /
`qwen3:8b`**; without them you only get a fallback verdict (see below).

```bash
ollama serve                       # in another terminal
ollama pull qwen3:4b qwen3:8b      # the target tier; optional but recommended

cd spikes/agent-loop
npm install && npm start           # install is a no-op (zero deps); run it anyway
# CHAT_MODELS=qwen3:8b npm start   # force a specific model / list
# OLLAMA=http://host:11434 npm start
# SELFTEST=1 npm start             # verify the verdict path with scripted chains (no Ollama)
```

`SELFTEST=1` drives the loop with a **scripted** model (no Ollama needed) to
exercise the parts no small-model run reaches: the happy 5-call chain
(`search → 3×read → write_note`) must yield `PASS=true`, the string-vs-int trap
(`k:"8"`) must yield exactly one violation and `PASS=false`, and a too-short
chain that still completes must `FAIL` the ≥5 gate. This pins the positive
completion branch the real qwen3 verdict will depend on.

With **no `CHAT_MODELS` override** the harness probes `ollama list` (`/api/tags`)
and runs the installed subset of `[qwen3:8b, qwen3:4b, llama3.2:3b]`
(best→worst); any candidate that isn't installed gets a clear **`absent →
skipped`** row in the table. `npm install` is a harmless no-op — the harness has
zero runtime deps (built-in `fetch`) and is a Node-native `.mts` file (Node
>=22.6 strips TS types at load, no build). If Ollama is unreachable, each model
preflight-skips with a message and the harness still exits cleanly.

## PASS / FAIL

**PASS (per model):** the run **completes ≥ 5 valid tool-calls** with **no
schema corruption** — i.e. `valid_calls ≥ 5`, `schema_violations == 0`, and the
model finishes by calling `write_note`.

**FAIL:** any schema violation (a bad-JSON arg, a missing required field, an
unknown tool, or the headline **string-vs-int trap** — an `integer` arg like
`k` sent as `"8"`), the loop stalls/loops before 5 valid steps, or it never
reaches `write_note`.

A schema violation does **not** crash the loop: the bad call is counted, the
tool is **not** run on bad args, an `{error: ...}` tool message is fed back, and
the loop continues — mirroring the "rejected steps, not corruption" behavior in
`docs/engineering-decisions.md` §5. The classifier type-checks only fields that
are *present* (so an omitted optional `k` is valid) and ignores unknown extra
fields; a real integer must satisfy `typeof === 'number' && Number.isInteger`.

The summary prints a **per-model PASS/FAIL table** with `valid_calls`,
`schema_violations`, `completed`, plus an overall `VERDICT` line. The live
question is whether the **4B tier** is good enough for Agent mode or whether
Agent must hardware-gate to 8B+ (and/or escalate to cloud per ADR-0002). If the
qwen3 tier isn't installed and only `llama3.2:3b` runs, the verdict is labelled
**`PROVISIONAL`** — the 4B/8B question stays formally open.

## Status: COMPLETE (runnable, prints a real verdict)

Validation/classification, completion detection, and PASS computation are all
wired up; there are no TODOs left in the measurement path. Both branches are
**executed**, not just inspected: `SELFTEST=1` drives the shipped `validateCall`
+ loop through a happy 5-call chain (→ `PASS=true`), the `k:"8"` trap (→ 1
violation, `PASS=false`), and a short-but-complete chain (→ `FAIL` the ≥5 gate).

**Observed (this box, 2026-06-14):** the qwen3 target tier was not installed, so
the harness ran the `llama3.2:3b` fallback only → **PROVISIONAL: FAIL** for the
3B. It made one valid `search_notes` call (correct integer `k`, no trap tripped)
then dropped to a prose answer instead of chaining `read_note → write_note`,
never reaching the 5-valid-call / `write_note` gate. That is the expected
small-model failure this spike exists to catch (cf. engineering-decisions.md §5,
which notes 3B-tier tool-loops are unreliable). **The headline qwen3:4b vs 8b
question remains unanswered** until those models are pulled and the harness re-run.
