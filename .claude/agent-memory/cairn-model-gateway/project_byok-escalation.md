---
name: byok-escalation
description: BYOK cloud escalation (ADR-0002) shipped 2026-07-08 — architecture invariants and what was deferred
metadata:
  type: project
---

BYOK cloud escalation landed in three commits (engine adapter / desktop key store + IPC / renderer escalate + settings). Approved by Torres 2026-07-08.

**Why:** ADR-0002 — cloud is opt-in escalation only, never a silent switch, because the user pays per token. Local-first invariant holds: zero outbound except user-configured Ollama and an explicit, confirmed escalation.

**How to apply — the load-bearing seams (verify still true before building on them):**
- One `CloudProvider` (`packages/engine/src/cloud-provider.ts`) implements the `ModelProvider` chat+stream seam over 4 kinds: `openai-compat`, `azure-openai`, `anthropic`, `bedrock`. `embed()` THROWS — cloud is never used for embeddings; retrieval/grounding stays local.
- Escalation routes per-turn: `ChatThread.send({ provider })` uses the cloud provider for THAT turn's chat only; `search()` embeddings still run on the global (Ollama) provider. So retrieval stays local even on an escalated turn.
- Cost surfacing: `ChatStreamCallbacks.onUsage` (added to the seam) carries real token counts + `costUsd` when the API returns it (OpenRouter). NEVER fabricate usage.
- Keys: `ProviderStore` (`apps/desktop/src/main/provider-store.ts`) is electron-free (injected `SecretCrypto`, wired to safeStorage in `ipc.ts`); secret is an encrypted blob in userData, never the vault, never the renderer. `list()` returns `hasKey` but no key material.
- The only place a cloud call is constructed is the `chat:send` escalation branch in `ipc.ts`, gated on an explicit `escalate` block naming a CONFIGURED provider. First-use-per-session confirm lives in the renderer (`EscalationConfirm` in App.tsx).
- New dep: `aws4fetch` (MIT, zero deps) for Bedrock SigV4 — dynamic-imported inside the bedrock path only.

**Deferred (issues filed, do NOT half-build):** #35 Bedrock real ConverseStream (binary event-stream; today non-stream fallback) · #36 pre-send numeric cost estimate (needs price manifest; today confirm shows model+what-sent, cost is post-hoc) · #37 model auto-discovery beyond /models (Azure deployments, Bedrock catalog) · #38 verify per-provider streaming/usage quirks against live keys.

**Gates at ship:** engine test:smoke 45 pass, desktop test 38 pass, root typecheck+build clean, dev boot markers fired. Everything tested against a fake fetch — no network in gates.
