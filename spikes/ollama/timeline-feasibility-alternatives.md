# Assumption: "Solo student ships full v1 in 16 weeks" — VERDICT: Infeasible as written
# Alternatives (durable copy; full reasoning in StructuredOutput)

Root cause = scope/time mismatch, not a missing library. Two independent levers reduce build burden
while preserving local-first / no-server / permissive ideals:
  (A) change SUBSTRATE so editor+graph+wikilink+vault+PDF-viewer+3-OS packaging come for free;
  (B) adopt permissive AI building blocks so gateway+RAG+agent-loop aren't hand-rolled.

## Substrate alternatives
- Obsidian community PLUGIN. App free for commercial use; plugins may be MIT/Apache; network calls
  (Ollama/cloud) + fs access allowed with README disclosure; no telemetry/obfuscation/ads/auto-update.
  Source: https://docs.obsidian.md/Developer+policies , https://obsidian.md/license
  => collapses Phase 0 (editor/wikilink/backlink/graph), most of Phase 4 (PDF viewer), Phase 6 packaging.
  Tradeoff: live inside Obsidian's plugin sandbox/UX; not a standalone notarized app; PRD "standalone
  Electron" identity changes. Permissive: YES.
- AppFlowy (Rust+Flutter, local-first): AGPL-3.0 => FORBIDDEN by PRD permissive-only policy. https://github.com/AppFlowy-IO/AppFlowy
- Reor (Electron+React, closest analog): AGPL-3.0, ARCHIVED 2026-03-07, last release v0.2.32 2025-04-05,
  113 open issues, editor+RAG ONLY (no PDF annotation, no agent modes). Confirms "can't lift code + subset
  + stalls" pitfall. https://github.com/reorproject/reor
- Open Notebook (lfnovo): MIT, but web app (Streamlit/SurrealDB server), created 2024-10, no markdown
  editor / no PDF annotation / no agent loop. Not a local desktop substrate. https://github.com/lfnovo/open-notebook

## AI building-block libraries (collapse multi-week subsystems)
- Vercel AI SDK: Apache-2.0. Unified streaming + tool-calling across Ollama/Anthropic/OpenAI-compat.
  => replaces hand-rolled "3-provider streaming gateway" + agent tool-call loop. https://github.com/vercel/ai (LICENSE = Apache-2.0)
- LlamaIndex.TS: MIT (run-llama org). RAG retrieval/index abstractions, local Ollama embeddings + chat.
  => replaces hand-rolled chunk/embed/retrieve/cite plumbing. https://github.com/run-llama/LlamaIndexTS
- Mastra: Apache-2.0 core (ee/ dirs source-available enterprise). Agent + graph workflow + RAG; 25k stars,
  active 2026. Heavier than needed for v1; AI SDK is lighter. https://github.com/mastra-ai/mastra

## Comparable-project ground truth (why 16wk solo is infeasible)
- Khoj: 2 co-founders + intern, repo 2021, full-time 2022, YC S23. AGPL. Not solo, ~3 yr.
  https://blog.khoj.dev/posts/10k-stars-in/
- Reor: ~18 mo then archived; subset only (above).
- Open Notebook: ~1.5 yr, web-only subset (above).

## Post-advisor corrections (verified)
- LlamaIndex.TS license CONFIRMED MIT (LICENSE file: "The MIT License", "Copyright (c) LlamaIndex").
  https://github.com/run-llama/LlamaIndexTS/blob/main/LICENSE
- Obsidian-plugin Phase-4 "savings" are PARTLY ILLUSORY. Plugins COMPLEMENT Obsidian's native PDF
  viewer, not replace it (PDF++ devs hook ObsidianViewer/PDFViewerChild + its annotation layer).
  Spike-2's full standalone-pdf.js coordinate control does NOT transfer into a plugin; custom
  area-annotation + selection->Tutor + custom full-pane ND-UX fight the host. Clean savings = Phase-0
  (editor/graph/wikilink/vault) + Phase-6 packaging only. https://github.com/RyotaUshio/obsidian-pdf-plus/wiki/For-developers
- DECISION: lead with verified-permissive STANDALONE path (Vercel AI SDK Apache-2.0 + LlamaIndex.TS MIT
  + descope to 1 OS / 1 provider / Tier-1 Studio / defer Agent + annotation polish). Demote
  Obsidian-plugin to higher-leverage-but-riskier alternative (identity shift + unverified PDF/ND-UX surface).
