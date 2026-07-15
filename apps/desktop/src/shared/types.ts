export type { AskResult, ChatSendResult, ChatUsage, EditProposal, DiffLine, DiffPreview, IndexStats, SearchHit } from "@cairn/engine";
export type { ProviderKind, ProviderPreset } from "@cairn/engine";
export type { TreeNode, TreeSortMode, AgentStartResult, AgentApplyResult } from "../main/vault-session.js";
export type { ProviderMeta, ProviderInput, TestConnectionResult } from "../main/provider-store.js";

export interface OllamaStatus {
  up: boolean;
  models: string[];
}

/** An explicit, confirmed BYOK escalation for one chat turn (ADR-0002). */
export interface EscalateTarget {
  providerId: string;
  model: string;
}

/** Payload for a `chat:send` invoke — carries the requestId used to drop stale tokens. */
export interface ChatSendPayload {
  text: string;
  requestId: number;
  model?: string;
  scope?: string[];
  /** Present only for a user-triggered, confirmed cloud escalation. */
  escalate?: EscalateTarget;
}

/** A streamed chat delta pushed from main → renderer, tagged with its originating requestId. */
export interface ChatTokenEvent {
  requestId: number;
  token: string;
}
