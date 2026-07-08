export type { AskResult, ChatSendResult, IndexStats, SearchHit } from "@cairn/engine";
export type { TreeNode } from "../main/vault-session.js";

export interface OllamaStatus {
  up: boolean;
  models: string[];
}

/** Payload for a `chat:send` invoke — carries the requestId used to drop stale tokens. */
export interface ChatSendPayload {
  text: string;
  requestId: number;
  model?: string;
  scope?: string[];
}

/** A streamed chat delta pushed from main → renderer, tagged with its originating requestId. */
export interface ChatTokenEvent {
  requestId: number;
  token: string;
}
