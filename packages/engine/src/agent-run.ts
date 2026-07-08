// Agent write-loop (ADR-0008 write-safety core, engine half).
//
// A BOUNDED tool-call loop: the always-on model proposes mutations by calling
// tools; this loop drives it, grounds it in retrieval (ADR-0005, like ChatThread),
// hard-stops at a step cap, and collects every proposed edit as a *pending diff*.
//
// The load-bearing invariant: THE ENGINE NEVER WRITES. It has no filesystem handle
// — only an injected `readNote` reader — so a flaky local-model loop can only ever
// produce proposals, never touch the vault. Approval + apply happen afterward,
// per-hunk, behind the main process's gated IPC (see apps/desktop agent-checkpoint).
//
// Two tools only, deliberately:
//   read_note(path)                 — read a note into context
//   propose_edit(path, newContent)  — propose replacing a note's full content
//
// Why full `newContent` and not a unified patch: small local models emit malformed
// patch hunks (wrong line numbers / context) far more often than they mangle a full
// rewrite, and the spike (spikes/ollama/capability.mjs) already saw a 3B model emit
// wrong-typed args. We take the whole new file and derive the diff ourselves
// (diff.ts), so the preview never trusts model-supplied line math.

import { createHash } from "node:crypto";
import { search } from "./retrieve.js";
import type { Mode, SearchHit } from "./retrieve.js";
import type { Index } from "./vault-index.js";
import { resolveChatModel } from "./chat.js";
import { getModelProvider } from "./model-provider.js";
import type { AgentMessage, ToolSchema } from "./model-provider.js";
import { diffLines, type DiffPreview } from "./diff.js";

/** Default hard step cap (ADR-0008 §0). Manifest-configurable upstream, never a magic constant here. */
export const DEFAULT_AGENT_STEP_CAP = 25;

const MAX_READ_CHARS = 8000;

/** A pending mutation the agent proposed. Nothing is on disk until it is approved + applied. */
export interface EditProposal {
  /** Stable within a run — the id the approval/apply IPC references. */
  id: string;
  /** Vault-relative POSIX path (validated against the vault root at apply time). */
  path: string;
  op: "add" | "modify";
  /** Full proposed file content. */
  newContent: string;
  /** sha256 of the on-disk content this edit was derived from ("" for a new file). */
  baseHash: string;
  /** Derived line diff for the approval card. */
  preview: DiffPreview;
}

export interface AgentRunOptions {
  index: Index;
  goal: string;
  model?: string;
  /** Path-validated note reader (main process supplies the vault-scoped one). Throws if unreadable. */
  readNote: (path: string) => Promise<string>;
  stepCap?: number;
  k?: number;
  mode?: Mode;
  scope?: string[];
  /** Fired as each proposal is collected (for streaming cards to the UI). The loop still never applies. */
  onProposal?: (proposal: EditProposal) => void;
}

export interface AgentRunResult {
  /** The model's closing prose (grounded, cited). */
  answer: string;
  /** Every edit the agent proposed, in order. */
  proposals: EditProposal[];
  /** Sources the run was grounded in (ADR-0005). */
  sources: SearchHit[];
  /** Model→tool cycles consumed (per-batch: one chatWithTools turn = one step). */
  steps: number;
  stopReason: "done" | "step-cap" | "no-tool-support";
  grounded: boolean;
  model?: string;
}

const TOOLS: ToolSchema[] = [
  {
    name: "read_note",
    description:
      "Read the full current contents of a Markdown note in the vault. Use this before proposing an edit so your edit is based on the real current text.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative path to the note, e.g. 01-courses/algebra.md" },
      },
      required: ["path"],
    },
  },
  {
    name: "propose_edit",
    description:
      "Propose replacing a note's ENTIRE contents with newContent. This does NOT write the file — the user reviews a diff and approves or rejects it. Provide the complete new file, not a patch. Ground your changes in the SOURCES and cite them.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative path to create or overwrite (must end in .md)" },
        newContent: { type: "string", description: "The complete new contents of the file" },
      },
      required: ["path", "newContent"],
    },
  },
];

const AGENT_SYSTEM = [
  "You are Cairn's write agent, operating over the user's local Markdown vault.",
  "You work by calling tools. You have exactly two:",
  "- read_note(path): read a note before you change it.",
  "- propose_edit(path, newContent): propose the COMPLETE new contents of a note.",
  "Rules:",
  "- Every proposed edit is only a PROPOSAL. The user approves or rejects each one via a diff preview; nothing you propose is written until they approve it.",
  "- Ground your edits in the numbered SOURCES from the user's own notes and cite them inline with bracketed numbers, e.g. [1]. Do not invent facts that are not in the sources or in a note you read.",
  "- Read a note with read_note before you overwrite it, so you preserve its existing content.",
  "- When your task is complete, stop calling tools and write a short summary of what you proposed.",
].join("\n");

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * Run the bounded agent write-loop. Returns collected proposals; applies nothing.
 * Requires a tool-calling provider (`chatWithTools`); degrades to a clean refusal
 * (`stopReason: 'no-tool-support'`) rather than silently doing nothing.
 */
export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const provider = getModelProvider();
  const stepCap = opts.stepCap ?? DEFAULT_AGENT_STEP_CAP;
  const k = opts.k ?? 6;

  const { hits } = await search(opts.index, opts.goal, { k, mode: opts.mode, scope: opts.scope });

  if (!provider.chatWithTools) {
    return {
      answer:
        "This model does not support tool-calling, which Agent mode needs. Pull a tool-capable local model (e.g. `ollama pull qwen3:4b`).",
      proposals: [],
      sources: hits,
      steps: 0,
      stopReason: "no-tool-support",
      grounded: hits.length > 0,
    };
  }

  const model = await resolveChatModel(opts.model);
  const sourcesBlock = hits
    .map((h, i) => `[${i + 1}] ${h.file}:${h.line}${h.heading ? ` > ${h.heading}` : ""}\n${h.text}`)
    .join("\n\n");

  const messages: AgentMessage[] = [
    { role: "system", content: AGENT_SYSTEM },
    {
      role: "user",
      content: `SOURCES:\n${sourcesBlock || "(no notes retrieved for this goal — use read_note to gather context)"}\n\nTASK: ${opts.goal}`,
    },
  ];

  const proposals: EditProposal[] = [];
  let steps = 0;
  let answer = "";
  let stopReason: AgentRunResult["stopReason"] = "done";

  for (;;) {
    if (steps >= stepCap) {
      stopReason = "step-cap";
      break;
    }
    const turn = await provider.chatWithTools(model, messages, TOOLS);
    steps++;

    if (turn.toolCalls.length === 0) {
      answer = turn.content;
      stopReason = "done";
      break;
    }

    messages.push({ role: "assistant", content: turn.content, toolCalls: turn.toolCalls });

    for (const call of turn.toolCalls) {
      if (call.name === "read_note") {
        const path = asString(call.arguments.path);
        if (!path) {
          messages.push({ role: "tool", toolName: "read_note", content: "ERROR: read_note requires a string 'path'." });
          continue;
        }
        try {
          const content = await opts.readNote(path);
          const clipped =
            content.length > MAX_READ_CHARS ? `${content.slice(0, MAX_READ_CHARS)}\n…(truncated)` : content;
          messages.push({ role: "tool", toolName: "read_note", content: clipped });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          messages.push({ role: "tool", toolName: "read_note", content: `ERROR: ${message}` });
        }
        continue;
      }

      if (call.name === "propose_edit") {
        const path = asString(call.arguments.path);
        const newContent = asString(call.arguments.newContent);
        if (!path || newContent === null) {
          messages.push({
            role: "tool",
            toolName: "propose_edit",
            content: "ERROR: propose_edit requires string 'path' and string 'newContent'.",
          });
          continue;
        }
        let base: string | null = null;
        try {
          base = await opts.readNote(path);
        } catch {
          base = null; // path unreadable/absent → treat as a new-file proposal
        }
        const proposal: EditProposal = {
          id: `p${proposals.length + 1}`,
          path,
          op: base === null ? "add" : "modify",
          newContent,
          baseHash: base === null ? "" : sha256(base),
          preview: diffLines(base ?? "", newContent),
        };
        proposals.push(proposal);
        opts.onProposal?.(proposal);
        messages.push({
          role: "tool",
          toolName: "propose_edit",
          content: `Proposal recorded for ${path} (+${proposal.preview.added} / -${proposal.preview.removed} lines). It is NOT written — the user will approve or reject it. Continue or finish.`,
        });
        continue;
      }

      messages.push({ role: "tool", toolName: call.name, content: `ERROR: unknown tool "${call.name}".` });
    }
  }

  return {
    answer,
    proposals,
    sources: hits,
    steps,
    stopReason,
    grounded: hits.length > 0,
    model,
  };
}
