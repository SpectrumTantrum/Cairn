---
name: propose-edit-full-content
description: Agent edit tool takes full newContent, not a unified patch, because small local models mangle patches; we derive the diff ourselves
metadata:
  type: feedback
---

The `propose_edit` tool takes the **complete new file content**, never a unified diff/patch.

**Why:** small local models (Qwen3-4B/8B, llama3.2:3b) emit malformed patch hunks — wrong line numbers, wrong context — far more often than they mangle a full rewrite. The `spikes/ollama/capability.mjs` spike already observed wrong-typed tool args from a 3B model. A patch that doesn't apply is a silent failure; a full rewrite always applies. We compute the diff ourselves (`packages/engine/src/diff.ts`, LCS line diff) so the preview never trusts model-supplied line math.

**How to apply:** keep write-tool contracts "give me the whole artifact," not "give me a patch," for anything a local model produces. Derive diffs/deltas engine-side for previews. This generalises to future write modes (Synthesize/Recall/Plan) and to Anki card generation.
