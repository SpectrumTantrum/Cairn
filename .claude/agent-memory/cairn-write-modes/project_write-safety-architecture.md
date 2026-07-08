---
name: write-safety-architecture
description: How the ADR-0008 write-safety core is split across engine and main process, and the collect-then-approve deviation from the ADR's blocking gate
metadata:
  type: project
---

The ADR-0008 write-safety core is split (Phase 3 first slice):

- **Engine** (`packages/engine/src/agent-run.ts`, `runAgent`): a bounded tool loop that grounds in retrieval, drives the model through two tools (`read_note`, `propose_edit`), hard-stops at a step cap (`DEFAULT_AGENT_STEP_CAP = 25`), and **collects proposals only — it has no filesystem handle, only an injected `readNote` reader, so it can never write.** This structural guarantee is the safety backstop.
- **Main process** (`apps/desktop/src/main/agent-checkpoint.ts` + `VaultSession.agentStart/agentApplyHunk/agentRejectHunk/agentRevertRun`): git checkpoint (A, lazily before the FIRST apply), per-hunk gated apply (concurrency-checked, path-validated like `source:write`, folded into one run-commit B via amend), and hand-rolled byte-identical revert (asserts tree(C)===tree(A)).
- **IPC:** `agent:start` / `agent:apply` / `agent:reject` / `agent:revert`.

**Deliberate deviation from ADR-0008 §1:** shipped **collect-then-approve** (loop finishes, then user approves each proposal), NOT the ADR's **mid-loop blocking `await approve(proposal)` gate**. The invariant still holds (no write without explicit per-file approval); the model just doesn't see approvals before its next step. Mid-loop blocking gate + step-cap partial-run UX tracked in issue #30.

**How to apply:** the "engine never writes" property is load-bearing and tested — keep the engine fs-free. Any new write path must go through `VaultSession`'s gated apply (path validation + concurrency check), never a direct `writeFileSync`.
