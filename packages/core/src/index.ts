/**
 * @walle-agent/core — Public API exports
 */

// Agent
export { Agent } from "./agent.js";

// Config types
export type {
  AgentConfig,
  AgentInput,
  AgentResult,
  RunOptions,
  ResolvedAgentConfig,
  TokenBudgetConfig,
  BuiltinToolsConfig,
  MacroCompressionConfig,
  ResolvedMacroCompressionConfig,
  ToolSearchConfig,
  ResolvedToolSearchConfig,
} from "./agent-config.js";

// Permissions
export type {
  PermissionPolicy,
  PermissionDecision,
  ApprovalRequest,
} from "./permissions.js";
export { checkToolPermission } from "./permissions.js";

// Message types
export type {
  ModelMessage,
  ModelToolCall,
  ModelToolDefinition,
  ContentBlock,
  TextBlock,
  ImageBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
} from "./message.js";

// LLM Provider
export type {
  LLMProvider,
  LLMChatRequest,
  LLMChatResponse,
  LLMStreamChunk,
  ReasoningConfig,
} from "./llm-provider.js";

// Tools
export type {
  Tool,
  ToolCallRecord,
  ToolExecutionContext,
  ToolAnnotations,
  DefineToolExtras,
} from "./tool.js";
export { defineTool, zodShapeToJsonSchema } from "./tool.js";

// Tool Registry
export { ToolRegistry } from "./tool-registry.js";

// Events
export { EventBus } from "./events.js";
export type { AgentEventMap, ContextItem, RunStatus } from "./events.js";

// Streaming
export { AgentStream } from "./stream.js";
export type {
  AgentStreamEvent,
  RunStartEvent,
  RunEndEvent,
  ModelCallStartEvent,
  ModelCallEndEvent,
  TextDeltaEvent,
  ToolCallDeltaEvent,
  ToolCallStartEvent,
  ToolCallEndEvent,
  LLMChunkEvent,
  ErrorEvent,
} from "./stream.js";

// Hooks
export { HookManager } from "./hooks.js";
export type { AgentHooks } from "./hooks.js";

// Middleware
export { MiddlewarePipeline } from "./middleware.js";
export type { Middleware } from "./middleware.js";

// Plugin
export type { WallePlugin } from "./plugin.js";

// Context
export type { AgentContext } from "./agent-context.js";
export { AgentContextImpl } from "./agent-context.js";

// Token Budget
export { TokenBudget } from "./token-budget.js";
export type { BudgetAllocation } from "./token-budget.js";

// Token estimator
export { estimateTokens, estimateStringTokens } from "./token-estimate.js";

// Message compaction
export {
  partitionByTurns,
  buildPlaceholder,
  isPlaceholder,
  TOOL_RESULT_PLACEHOLDER_PREFIX,
} from "./message-compactor.js";
export type { PartitionResult, PlaceholderInput } from "./message-compactor.js";

// Conversation summarizer
export {
  summariseConversation,
  renderMessagesForSummary,
  DEFAULT_SUMMARY_PROMPT,
  SUMMARY_MESSAGE_PREFIX,
} from "./conversation-summarizer.js";
export type { SummariseInput } from "./conversation-summarizer.js";

// Prompt Builder
export { PromptBuilder } from "./prompt-builder.js";

// Shared types
export type { JSONSchema, TokenUsage, Attachment, AnyRecord } from "./types.js";

// Built-in tools
export {
  BUILTIN_TOOLS,
  lsTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  globTool,
  grepTool,
  bashTool,
  planTool,
  writeTodosTool,
  getPlanStore,
  clearPlanStore,
  getTodoStore,
  clearTodoStore,
  createTaskTool,
  TASK_TOOL_NAME,
  readToolResultTool,
  READ_TOOL_RESULT_NAME,
  createToolSearchTool,
  TOOL_SEARCH_NAME,
  DEFER_EXECUTE_NAME,
  buildToolSearchDescription,
  compileKeyword,
  scoreTool,
  deriveServerName,
  createDeferExecuteTool,
  createWebFetchTool,
  WEB_FETCH_NAME,
  htmlToMarkdown,
  clearWebFetchCache,
} from "./builtin-tools/index.js";
export type { Plan, PlanStep, PlanToolInput } from "./builtin-tools/index.js";
export type {
  TaskToolInput,
  TaskToolOutput,
  TaskToolSuccessOutput,
  TaskToolErrorOutput,
  CreateTaskToolOptions,
  ReadToolResultInput,
  ReadToolResultOutput,
  ReadToolResultErrorOutput,
  ToolSearchInput,
  ToolSearchOutput,
  ToolSearchMatch,
  ToolSearchErrorOutput,
  CreateToolSearchOptions,
  DeferExecuteInput,
  DeferExecuteOutput,
  DeferExecuteErrorOutput,
  CreateDeferExecuteOptions,
  CheckPermissionFn,
  WebFetchInput,
  WebFetchOutput,
  WebFetchSuccessOutput,
  WebFetchRedirectOutput,
  WebFetchErrorOutput,
  CreateWebFetchOptions,
} from "./builtin-tools/index.js";

// Sub-agent registry
export { SubAgentRegistry } from "./sub-agent-registry.js";
export type { SubAgentDefinition } from "./sub-agent-registry.js";
