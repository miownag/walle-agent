/**
 * @walle-agent/memory — public API.
 */

export { MemoryPlugin } from "./memory-plugin.js";
export { MemoryManager } from "./memory-manager.js";
export type { RememberInput, MemoryManagerConfig } from "./memory-manager.js";

export { FileMemoryStore } from "./file-memory-store.js";
export type { MemoryStore } from "./file-memory-store.js";

export { SessionLog } from "./session-log.js";
export { ToolResultVault, tryDecodeEviction } from "./tool-result-vault.js";
export type { ToolResultVaultOptions } from "./tool-result-vault.js";

export { buildRememberTools } from "./remember-tools.js";

export { jaccard, keywordScore } from "./similarity.js";

export type {
  MemoryPluginConfig,
  MemoryItem,
  MemoryScope,
  MemoryType,
  MemoryQuery,
  MemoryRetrieveOptions,
  SessionMessageRecord,
  SessionRunRecord,
  EvictedToolResult,
  EvictedToolResultMeta,
} from "./memory-types.js";
export { EVICTED_TOOL_RESULT_KIND } from "./memory-types.js";
