export {
  indexVault,
  discoverMarkdownFiles,
  chunkVaultFiles,
  embedPendingChunks,
  persistVaultIndex,
} from "./indexer.js";
export type { IndexStats, PendingChunk, EmbedChunksResult } from "./indexer.js";
export { search, sanitizeForFts, rrfFuse, DEFAULT_COVERAGE_THRESHOLD } from "./retrieve.js";
export type { Mode, SearchCoverage, SearchHit, SearchOpts } from "./retrieve.js";
export { ask, GROUNDING_SYSTEM } from "./ask.js";
export type { AskResult } from "./ask.js";
export { ChatThread } from "./chat-thread.js";
export type { ThreadTurn, ChatThreadOptions, ChatSendOptions, ChatSendResult, SentPayload } from "./chat-thread.js";
export { CloudProvider, PROVIDER_PRESETS } from "./cloud-provider.js";
export type {
  ProviderKind,
  ProviderPreset,
  CloudProviderConfig,
  CloudCredentials,
} from "./cloud-provider.js";
export { chat, chatStream, resolveChatModel } from "./chat.js";
export { runAgent, DEFAULT_AGENT_STEP_CAP } from "./agent-run.js";
export type { AgentRunOptions, AgentRunResult, EditProposal } from "./agent-run.js";
export { diffLines } from "./diff.js";
export type { DiffLine, DiffPreview } from "./diff.js";
export {
  parseWikilinks,
  resolveWikilink,
  computeBacklinks,
  buildBacklinkIndex,
} from "./wikilinks.js";
export type { WikiLink, WikiResolveResult, VaultDoc, Backlink } from "./wikilinks.js";
export { openIndex, SqliteIndex } from "./vault-index.js";
export type { Index, ChunkRow, DenseHit, RebuildChunkInput, RebuildIndexInput } from "./vault-index.js";
export { getModelProvider, setModelProvider, resetModelProvider, OllamaClient } from "./model-provider.js";
export type {
  ModelProvider,
  ChatMessage,
  ChatStreamCallbacks,
  ChatUsage,
  AgentMessage,
  ToolSchema,
  ToolCall,
  ToolTurn,
} from "./model-provider.js";
export { ollamaUp, listModels } from "./embed.js";
