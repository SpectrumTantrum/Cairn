export {
  indexVault,
  discoverMarkdownFiles,
  discoverIndexableFiles,
  chunkVaultFiles,
  embedPendingChunks,
  persistVaultIndex,
  chunkNeedsEmbedding,
  isIndexableVaultPath,
} from "./indexer.js";
export { decodeUtf8Text, EMPTY_TABLE_MESSAGE, INVALID_UTF8_MESSAGE } from "./utf8-text.js";
export { IMAGE_NO_TEXT, imageMimeType, isImagePath } from "./image-files.js";
export { AUDIO_NO_TEXT, audioMimeType, isAudioPath } from "./audio-files.js";
export { VIDEO_NO_TEXT, videoMimeType, isVideoPath } from "./video-files.js";
export { extractHtmlText, HTML_NO_TEXT } from "./html-text.js";
export {
  DOCX_NO_TEXT,
  DOCX_TEXT_CAP,
  DOCX_UNREADABLE,
  extractDocxText,
  isDocxPath,
  limitDocxText,
  renderDocxXml,
} from "./docx-text.js";
export {
  PPTX_NO_TEXT,
  PPTX_SLIDE_CAP,
  PPTX_TEXT_CAP,
  PPTX_UNREADABLE,
  extractPptxText,
  isPptxPath,
  splitPptxSlides,
} from "./pptx-text.js";
export {
  readZipEntry,
  ZIP_RATIO_CAP,
  ZIP_RATIO_MIN_UNCOMPRESSED,
  ZIP_UNCOMPRESSED_CAP,
  ZipError,
} from "./zip-read.js";
export { extractPdfPages, pdfPageHeading, textFromItems, PdfTextError } from "./pdf-text.js";
export type { PdfPageText } from "./pdf-text.js";
export type { IndexStats, PendingChunk, EmbedChunksResult } from "./indexer.js";
export { search, sanitizeForFts, rrfFuse, DEFAULT_COVERAGE_THRESHOLD } from "./retrieve.js";
export type { Mode, SearchCoverage, SearchHit, SearchOpts } from "./retrieve.js";
export { ask, GROUNDING_SYSTEM, CLASSIC_USER_PREFIX, classicAskUserContent } from "./ask.js";
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
export { chat, chatStream, pickChatModel, resolveChatModel } from "./chat.js";
export type { ResolveChatModelOptions } from "./chat.js";
export { runAgent, DEFAULT_AGENT_STEP_CAP } from "./agent-run.js";
export type { AgentRunOptions, AgentRunResult, EditProposal } from "./agent-run.js";
export {
  runAskAgent,
  ASK_AGENT_SYSTEM,
  AGENTIC_WARM_USER_PREFIX,
  agenticAskUserContent,
  DEFAULT_ASK_AGENT_STEP_CAP,
  DEFAULT_ASK_AGENT_WALL_MS,
  DEFAULT_ASK_AGENT_FIRST_TURN_TIMEOUT_MS,
} from "./ask-agent.js";
export type { AskAgentOptions, AskAgentResult, AskAgentProgress, RetrievalSeedOption } from "./ask-agent.js";
export {
  ASK_SEARCH_TOOLS,
  ASK_SEARCH_TOOL_NAMES,
  labelAskSearchToolCall,
  runAskSearchTool,
} from "./agent-search-tools.js";
export type { OpenAnchor, AskSearchToolContext, AskSearchToolState } from "./agent-search-tools.js";
export { STUDIO_TEMPLATES, getStudioTemplate, studioTemplateMetas } from "./studio-templates.js";
export type { StudioTemplate, StudioTemplateMeta, StudioPrompt } from "./studio-templates.js";
export { generateStudioNote } from "./studio-generate.js";
export type { StudioGenerateOptions, StudioGenerateResult, GeneratedNote } from "./studio-generate.js";
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
export {
  getModelProvider,
  setModelProvider,
  resetModelProvider,
  resetOllamaHttpClient,
  OllamaClient,
  OllamaTimeoutError,
  OLLAMA_TAGS_TIMEOUT_MS,
  OLLAMA_EMBED_TIMEOUT_MS,
  OLLAMA_CHAT_TIMEOUT_MS,
  OLLAMA_CHAT_STREAM_TIMEOUT_MS,
  OLLAMA_CHAT_TOOLS_TIMEOUT_MS,
  OLLAMA_WARM_TIMEOUT_MS,
  agentMessagesToOpenAI,
  nextOllamaWarmGate,
  ollamaInstanceToken,
  ollamaWarmInvalidated,
} from "./model-provider.js";
export type { ChatWarmResult, ChatWarmKind, ChatWarmRequest, OllamaWarmProbe } from "./model-provider.js";
export { chatWarmRequest } from "./chat-warm.js";
export type {
  ModelProvider,
  ChatMessage,
  ChatStreamCallbacks,
  ChatUsage,
  AgentMessage,
  ToolSchema,
  ToolCall,
  ToolTurn,
  ChatWithToolsOptions,
} from "./model-provider.js";
export { ollamaUp, listModels } from "./embed.js";
