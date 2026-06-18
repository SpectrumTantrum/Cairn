# Cairn — Model Strategy (tiered always-on + cloud escalation)

> **Snapshot: June 2026.** Model names, sizes, and prices below are a point-in-time recommendation, not constants. Models churn faster than release cycles — Cairn must ship the tier→model mapping as a **runtime-updatable manifest**, not hard-coded values (see ADR-0002). Re-verify any specific size/price against the live Ollama library / vendor pricing before relying on it.
>
> **Currency caveat:** the research underlying this doc surfaced two *disputed* releases — **Qwen 3.5 (Feb 2026)** and **Gemma 4 (Apr 2026)**. One research thread reported them live on Ollama with sizes; an independent thread + its verifier flagged them as unverifiable content-farm "phantom" releases. They are **deliberately NOT used below** — the matrix is built on models verified to exist (Qwen3 ladder, Gemma 3, EmbeddingGemma, Qwen3-Embedding). If Qwen3.5/Gemma4 are real, slot them into the same tier shape once confirmed against ollama.com.

## Core principles

- **Two local per-task models:** an **always-on chat model** (sized to the hardware tier) and an **embedding model** (cheap; see the dimension-lock-in note). Both can be local-only → Cairn is fully usable offline.
- **The always-on chat model scales with hardware; the embedding model does NOT.** The embedder is a single app-wide default (one model + dimension for every install) — embedders are small enough to run well on any tier (the chat model is the memory constraint, not the embedder). The user can switch the embedder at will; switching re-indexes the whole vault. See the embedding section below.
- **Cloud is escalation, never default.** A small curated BYOK ladder for requests that are genuinely too hard for the local model. Escalation is always **explicit and cost-surfaced** (the user pays per token) — never silent.
- **Resident-memory budget is `min(GPU-wired ceiling, total − OS − browser − embedder − KV cache)`** with ~25–35% RAM left free to avoid swap. On Apple Silicon, Metal wires only ~66% of unified RAM as GPU memory below 64 GB (~75% at 64 GB+). Size **one notch below naive math.**

## Hardware tiers (2025–2026 students)

Headline correction from the research: **base Apple Silicon laptops have shipped with 16 GB since Oct 2024**, so "8 GB Apple" is legacy-only and **16 GB (T2) is the modal student machine.**

| Tier | Machine | Always-on resident budget |
|---|---|---|
| **T0** cloud-lean | ≤8 GB, integrated/no GPU, Chromebook-class | Tiny model only; lean on cloud |
| **T1** entry | 8 GB unified (legacy M-series Air) / 8 GB RAM + weak GPU | ~2–3 GB for a small model |
| **T2** mid *(modal)* | 16 GB unified / 16 GB RAM + ~8 GB VRAM | ~5–6 GB; first tier comfortable for concurrent embed+chat |
| **T3** high | 24–36 GB unified (M Pro/Max) / 12–16 GB VRAM (RTX 4070/4080) | ~10–14 GB |
| **T4** power | 48 GB+ unified (M Max/Ultra) / 24 GB+ VRAM (RTX 4090) | ~20–28 GB |

> Windows discrete-GPU VRAM is a hard wall (can't spill to system RAM without big penalties); Apple unified memory is softer but capped by the Metal wired limit.

## Always-on chat model — per tier (default: **Qwen3 ladder**, Apache-2.0)

Qwen3 is the default backbone: Apache-2.0 (clean for a permissively-licensed app), maps ~1:1 onto the tiers, and has the strongest small-model **tool-calling** — which is a *hard filter* here because the app drives an agent loop. (Evidence note: Qwen3's tool-calling lead rests on a real agent-loop eval — Qwen3-8B 0.93 vs Llama-3.1-8B 0.84 vs Gemma-3-4B 0.73 — *not* on BFCL, where the verifier found the cited numbers shaky. Run Qwen3 with **thinking OFF** by default for snappy chat.)

| Tier | Default always-on | Footprint (Q4 download) | Notes |
|---|---|---|---|
| T0 | Qwen3-1.7B (or 0.6B) | 1.4 GB / 523 MB | Don't pin resident; route real work to cloud |
| T1 | **Qwen3-4B** | 2.5 GB | Standout small model; unload between bursts |
| T2 | **Qwen3-8B** | 5.2 GB | Mainstream default; best documented small-model tool-calling |
| T3 | Qwen3-14B *(or 30B-A3B MoE on 24 GB+ for speed)* | 9.3 GB / 19 GB | MoE keeps decode fast despite larger footprint |
| T4 | Qwen3-32B *or* 30B-A3B | 20 GB / 19 GB | 30B-A3B often the better *always-on* pick (responsiveness) |

**License guardrails (surface at install):** Qwen3 = Apache-2.0 ✅. Phi-4 (14B) = MIT ✅ (alt at T3). Gemma 3 = Gemma Terms (non-OSI, use restrictions) ⚠. Llama 3.2/3.3 = Llama Community License (non-OSI) ⚠. Ministral-8B = non-commercial Research License ❌ (don't bundle). DeepSeek-R1-distill: weights MIT but mandatory reasoning traces fight "always-on snappy" — not a default.

## Embedding model — local (cheap; runs on every tier)

The app ships **one default embedder**; the user may switch to any of these at will, and switching **re-indexes the vault**. Embedders are small relative to the chat model, so quality-per-byte and **license** matter more than tier-fit. All pre-cutoff, verified to exist:

| Model | Dim | Footprint | License | Note |
|---|---|---|---|---|
| **Qwen3-Embedding-0.6B** | 1024 (MRL 32–1024) | 639 MB, 32K ctx | **Apache-2.0** ✅ | **App-wide default.** Best clean-license quality/size; 32K ctx great for PDF chunks |
| nomic-embed-text v1.5 | 768 (MRL→64) | 274 MB, 8K ctx | Apache-2.0 ✅ | Switch target: ultra-light alternative for the tightest machines |
| EmbeddingGemma-300m | 768 (MRL 512/256/128) | 622 MB (~200 MB QAT) | Gemma Terms ⚠ | Switch target: strong <500M, but non-OSI license |
| Qwen3-Embedding-4B / 8B | 2560 / 4096 | 2.5 / 4.7 GB | Apache-2.0 ✅ | Switch target: higher retrieval quality for power users; bigger dim → larger index |

> **Dimension note:** a `sqlite-vec` table is fixed to one vector dimension, so switching the embedder (or its dimension) requires a **full re-index** — which is exactly why switching is modeled as a first-class, user-triggered operation rather than something to avoid.

> **Retrieval-quality validation (2026-06-14, `spikes/rag-quality-v2/`):** the original 50-Q self-test was lexically leaky — a plain TF-IDF baseline tied/beat it, so it couldn't separate embedding quality from word-overlap (see `docs/spike-verdicts-correction.md`). Re-validated on human-judged **BEIR** benchmarks with an **independently-audited** harness (our BM25 reproduces the published BEIR baseline almost exactly): **Qwen3-Embedding-0.6B beats BM25** — SciFact nDCG@10 70.4 vs 67.8, NFCorpus 36.4 vs 32.4 — and the win concentrates where it must, on **low-lexical-overlap (paraphrase) queries** (SciFact low-overlap bucket +7.1); hybrid (dense+BM25 RRF) ≥ both arms. **Load-bearing requirement:** queries MUST be embedded with Qwen3-Embedding's **instruction prefix** (`Instruct: {task}\nQuery: {text}`); *without* it, dense actually **loses** to BM25 on NFCorpus (29.9 vs 32.4). **Caveat:** BEIR is plausibly in the embedder's training data, so a Cairn-specific **out-of-domain notes corpus (chunk-level)** is the confirmatory test before this is fully locked.

## Cloud escalation — BYOK, hardware-independent (3 rungs)

All BYOK (Cairn stores the key locally, never proxies). Prices = input/output per 1M tokens; **verify against live vendor pages before hardcoding.** Claude names confirmed against this environment; OpenAI/Gemini point-versions are the research's June-2026 snapshot.

| Rung | Anthropic | OpenAI | Google | When |
|---|---|---|---|---|
| **Cheap-fast** | Haiku 4.5 ($1/$5, 200K) | GPT-5.x-mini (~$0.75/$4.50 — verify) | Gemini 2.5 Flash-Lite ($0.10/$0.40) | Quick assists, high-volume summarization; T0/T1 everyday |
| **Balanced** *(default escalate)* | **Sonnet 4.6 ($3/$15, 1M ctx)** | GPT-5.4 ($2.50/$15, 1.1M) | — | Long readings, essay feedback, multi-doc synthesis, image PDFs |
| **Frontier** | Opus 4.8 ($5/$25, 1M) | GPT-5.5 ($5/$30) | Gemini 3.1 Pro ($2/$12, **2M ctx**) | Hardest reasoning, agentic chains; Gemini for huge-context synthesis |

**Optional:** OpenRouter single-key gateway — one key for all vendors + open-weight models (e.g. MiniMax M3, frontier-ish at ~6% of Opus token cost). **Cost (corrected):** ~0% markup on inference (passthrough), **+5% BYOK fee** beyond 1M free requests/month (or 5.5% on credit top-ups) — *not* the ~1% the first research pass claimed.

**Escalation heuristic (local-first cascade):** stay local by default; escalate only on (1) long-context beyond local window, (2) hard multi-step reasoning / failed self-check / user "try harder", (3) agentic multi-tool, (4) vision/audio the local model can't parse. Cheapest viable rung first. T0/T1 escalate sooner; T3/T4 rarely. Always show model + estimated reason/cost before spending. Use prompt caching for repeated study material (~90% off).

## Always-on runtime (Ollama)

- Pin resident via `keep_alive: -1` (or `OLLAMA_KEEP_ALIVE=-1`); default is 5-min idle unload. State is runtime-only (lost on restart) → **warm-up request on app launch.**
- **Tier-differentiated pinning:** pin *both* embedder + chat only on **T2+**. On **T0/T1**, pin only the tiny embedder (or load-embed-unload) and let chat unload / lean on cloud — pinning both OOMs or spills to CPU.
- Resident RAM = weights + `num_parallel × context` KV cache + runtime overhead — noticeably above the download size. Keep context modest (RAG supplies the knowledge, so the chat model needs little context).
- **First-run:** detect RAM/VRAM and badge which models "fit" (LM Studio pattern: target ~80% of available memory, leave KV headroom), then recommend the tier's defaults.

## Embedding strategy (resolved) — free, re-indexable user choice

There is **one app-wide embedding model** (one model + dimension for every install, regardless of hardware tier), which the user can switch at will:

- **Default (app-wide):** **Qwen3-Embedding-0.6B** — Apache-2.0, 1024-dim, 32K context, 639 MB; runs on every tier (resident on T2+, load-on-demand on T0/T1). The default is the *same for everyone* — it is NOT chosen per tier.
- **Switchable:** the user can change the embedding model whenever they like (e.g. to a larger one like Qwen3-Embedding-4B/8B for higher retrieval quality, or a lighter one like nomic-embed-text).
- **Switching triggers a full re-index** of the vault — a **first-class, supported operation**, not an error/edge case. The portability that matters lives in the **vault** (plain files, synced), not the index.
- **The index is per-machine and never synced.** A vault synced across two machines is re-indexed locally on each; each machine can choose its own embedder. This follows Cairn's "the vault IS the database; the index is derived" principle.

**Engine implications:**
- `embedding_cache` must be keyed by **`(chunk_hash, embedder_id, dimension)`** — switching models must not return stale vectors, and switching *back* can reuse cached vectors.
- A re-index after an embedder switch reuses **extraction + chunking** caches (keyed by `file_hash`) and only re-embeds — so the cost is embedding time, not re-parsing every PDF.
- The index records which embedder + dimension produced it; on mismatch (user switched, or opened a vault indexed elsewhere) Cairn detects it and offers/triggers a re-index.
- `.cairn/index.db` is git-ignored / not synced; only the vault's plain files are portable.
- **Query embedding uses the asymmetric instruction prefix.** Qwen3-Embedding is trained for asymmetric retrieval: embed chunks/documents as-is, but embed **queries** as `Instruct: {retrieval task}\nQuery: {text}`. This is load-bearing — it flips the dense-vs-BM25 result on out-of-domain data (see the validation note above) — so the engine must prefix queries and must NOT prefix stored chunks. If the embedder is switched to a non-Qwen3 model, revisit the prefix (model-specific).

(No ADR for this — it's an extension of the PRD's existing "plain files first, index is derivative" principle, and re-indexing is by definition reversible, so it fails the "hard to reverse" ADR test.)
