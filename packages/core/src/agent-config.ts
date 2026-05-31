/**
 * AgentConfig — configuration types for Agent creation.
 */

import type { LLMProvider } from "./llm-provider.js";
import type { Tool } from "./tool.js";
import type { WallePlugin } from "./plugin.js";
import type { AgentHooks } from "./hooks.js";
import type { Middleware } from "./middleware.js";
import type { ModelMessage } from "./message.js";
import type { ToolCallRecord } from "./tool.js";
import type { TokenUsage, Attachment } from "./types.js";
import type { ContentBlock } from "./message.js";
import type { AgentStreamEvent } from "./stream.js";
import type { PermissionPolicy } from "./permissions.js";

// Re-export so existing imports (`@walle-agent/core`) keep working.
export type { PermissionPolicy, PermissionDecision, ApprovalRequest } from "./permissions.js";

// ─── AgentInput / AgentResult ──────────────────────────────────────

export interface AgentInput {
  content: string | ContentBlock[];
  userId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  attachments?: Attachment[];
}

export interface AgentResult {
  content: string;
  messages: ModelMessage[];
  toolCalls: ToolCallRecord[];
  events: AgentStreamEvent[];
  usage?: TokenUsage;
  metadata?: Record<string, unknown>;
}

// ─── RunOptions ────────────────────────────────────────────────────

export interface RunOptions {
  /** Enable streaming */
  stream?: boolean;
  /** Session ID for multi-turn conversation */
  sessionId?: string;
  /** User ID */
  userId?: string;
  /** Override maxTurns */
  maxTurns?: number;
  /** AbortSignal */
  signal?: AbortSignal;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

// ─── TokenBudget Config ────────────────────────────────────────────

export interface TokenBudgetConfig {
  /** Maximum context tokens */
  maxContextTokens?: number;
  /** Reserved tokens for system prompt */
  systemReserve?: number;
  /** Reserved tokens for completion */
  completionReserve?: number;
}

// ─── AgentConfig ───────────────────────────────────────────────────

export interface BuiltinToolsConfig {
  /**
   * Tool names to exclude from auto-registration.
   * E.g., ["bash"] to disable shell access.
   */
  excludeTools?: string[];

  /**
   * Only include these tools (if specified, excludeTools is ignored).
   * E.g., ["read_file", "ls", "glob"] for a read-only agent.
   */
  includeTools?: string[];
}

export interface AgentConfig {
  id?: string;
  name: string;
  description?: string;
  /** LLM Provider instance */
  model: LLMProvider;
  /** System prompt */
  systemPrompt?: string;
  /**
   * Session id. If omitted, a UUID is generated at `Agent.create` and exposed
   * via `agent.sessionId`. Used by `MemoryPlugin` to persist conversation
   * history and by `Agent.resume` to re-attach to an existing session.
   */
  sessionId?: string;
  /** Native tools */
  tools?: Tool[];
  /** Plugin list */
  plugins?: WallePlugin[];
  /** Hooks shorthand */
  hooks?: Partial<AgentHooks>;
  /** Middleware shorthand */
  middleware?: Middleware[];
  /** Token budget strategy */
  tokenBudget?: TokenBudgetConfig;
  /** Max execution turns */
  maxTurns?: number;
  /** Max tool calls per turn */
  maxToolCallsPerTurn?: number;
  /** Permission policy */
  permissions?: PermissionPolicy;
  /**
   * Built-in tools configuration.
   * - true (default): register all built-in tools (ls, read_file, write_file, edit_file, glob, grep, bash, plan, write_todos)
   * - false: disable all built-in tools
   * - BuiltinToolsConfig: fine-grained control via include/exclude
   */
  useBuiltinTools?: boolean | BuiltinToolsConfig;
}

// ─── Resolved Config ───────────────────────────────────────────────

export interface ResolvedAgentConfig extends Required<Pick<AgentConfig, "name" | "model">> {
  id: string;
  sessionId: string;
  description?: string;
  systemPrompt?: string;
  tools: Tool[];
  plugins: WallePlugin[];
  hooks?: Partial<AgentHooks>;
  middleware: Middleware[];
  tokenBudget: TokenBudgetConfig;
  maxTurns: number;
  maxToolCallsPerTurn: number;
  permissions?: PermissionPolicy;
  useBuiltinTools: boolean | BuiltinToolsConfig;
}

function newUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function resolveConfig(config: AgentConfig): ResolvedAgentConfig {
  return {
    id: config.id ?? newUuid(),
    sessionId: config.sessionId ?? newUuid(),
    name: config.name,
    description: config.description,
    model: config.model,
    systemPrompt: config.systemPrompt,
    tools: config.tools ?? [],
    plugins: config.plugins ?? [],
    hooks: config.hooks,
    middleware: config.middleware ?? [],
    tokenBudget: config.tokenBudget ?? {
      maxContextTokens: 128_000,
      systemReserve: 2000,
      completionReserve: 4096,
    },
    maxTurns: config.maxTurns ?? 20,
    maxToolCallsPerTurn: config.maxToolCallsPerTurn ?? 10,
    permissions: config.permissions,
    useBuiltinTools: config.useBuiltinTools ?? true,
  };
}
