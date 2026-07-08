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
export type { ThreadTurn, ChatThreadOptions, ChatSendOptions, ChatSendResult } from "./chat-thread.js";
export { chat, chatStream, resolveChatModel } from "./chat.js";
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
export type { ModelProvider, ChatMessage, ChatStreamCallbacks } from "./model-provider.js";
export { ollamaUp, listModels } from "./embed.js";
