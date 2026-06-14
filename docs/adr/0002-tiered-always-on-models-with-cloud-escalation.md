# Tiered always-on local models with explicit BYOK cloud escalation

Cairn detects the user's **hardware tier** at first run and recommends a tier-sized **always-on local chat model** plus a local **embedding model**, both running offline by default. Harder requests **escalate** to a small curated set of **BYOK cloud models** via an explicit, cost-surfaced action — never a silent switch, because the user pays per token. The concrete tier→model mapping is shipped as a **runtime-updatable manifest, not hard-coded**, because local and cloud models churn far faster than app release cycles (this decision's own research, ~4 months past the author's reference point, already surfaced disputed new releases and stale prices).

## Considered options

- **Single user-picked model (no tiering):** simplest, but dumps model selection on students who don't know their VRAM budget, and silently underperforms or OOMs. Rejected — the first-run hardware-detection + recommendation is the product's "zero-setup" promise (persona P2).
- **Hard-coded model list:** simplest to build, but goes stale within weeks (proven here). Rejected in favor of a manifest the app can refresh.
- **Cloud-first / always-route-to-cloud:** best quality, but breaks the local-first/privacy/offline guarantee that is Cairn's reason to exist. Rejected — cloud is opt-in escalation only.

## Consequences

- The **ModelGateway** must support per-task model assignment (always-on chat / embedding / cloud) and a routing layer that decides local-vs-escalate on explicit triggers (context length, failed self-check or user "try harder", agentic, vision).
- **First-run** must probe RAM/VRAM, badge which models fit, and pull the tier's defaults — a real subsystem, not a settings toggle.
- **Resident-model policy is tier-differentiated:** pin both embedder + chat only on T2+; on T0/T1 pin only the tiny embedder and let chat unload / lean on cloud (pinning both OOMs low-RAM machines).
- Escalation UI must surface the target model and an estimated cost/reason before spending a BYOK key — a trust/billing requirement, not a nicety.
- Default local weights should be **Apache-2.0/MIT** (Qwen3 family, Phi-4) to stay consistent with Cairn's permissive policy; non-OSI weights (Gemma Terms, Llama Community License) are offered but flagged at install. (These are user-pulled via Ollama, not redistributed by Cairn.)
- The concrete model picks live in `docs/model-strategy.md` (a snapshot to maintain), deliberately separate from this ADR (the durable shape).
