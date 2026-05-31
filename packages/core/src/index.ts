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
export type { Tool, ToolCallRecord, ToolExecutionContext } from "./tool.js";
export { defineTool } from "./tool.js";

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
} from "./builtin-tools/index.js";
export type { Plan, PlanStep, PlanToolInput } from "./builtin-tools/index.js";
