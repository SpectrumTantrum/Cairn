export { indexVault } from "./indexer.js";
export type { IndexStats } from "./indexer.js";
export { search, sanitizeForFts, rrfFuse, DEFAULT_COVERAGE_THRESHOLD } from "./retrieve.js";
export type { Mode, SearchCoverage, SearchHit, SearchOpts } from "./retrieve.js";
export { ask } from "./ask.js";
export type { AskResult } from "./ask.js";
export { Store } from "./store.js";
export type { ChunkRow } from "./store.js";
