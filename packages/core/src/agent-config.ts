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
import type { SubAgentDefinition } from "./sub-agent-registry.js";

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

// ─── Macro Compression Config ──────────────────────────────────────

/**
 * Configuration for the macro (conversation summary) compaction pass.
 * Disabled by default (no implicit LLM cost). Enable by setting
 * `macroCompression: { enabled: true }`.
 *
 * See `docs/21-context-compression.md` for the full semantics.
 */
export interface MacroCompressionConfig {
  /** Default: false. Set true to opt-in. */
  enabled?: boolean;
  /**
   * Threshold as a fraction of `tokenBudget.maxContextTokens`. When the
   * estimated tokens of the live `messages` array exceeds this fraction,
   * `AgentRuntime` runs macro compression at the top of the next turn.
   * Default: 0.8.
   */
  threshold?: number;
  /** How many recent assistant turns to preserve verbatim. Default: 3. */
  keepRecentTurns?: number;
  /**
   * LLM used to produce the summary. Defaults to the agent's main `model`.
   * Pass a cheaper provider here (e.g. Haiku) to keep cost low.
   */
  summaryModel?: LLMProvider;
  /**
   * Override the default summary prompt. Must contain the placeholder
   * `{{messages}}` exactly once.
   */
  summaryPrompt?: string;
  /**
   * Skip the auto-trigger entirely; only `agent.compact()` runs macro.
   * Default: false.
   */
  manualOnly?: boolean;
}

export interface ResolvedMacroCompressionConfig {
  enabled: boolean;
  threshold: number;
  keepRecentTurns: number;
  summaryModel?: LLMProvider;
  summaryPrompt?: string;
  manualOnly: boolean;
}

// ─── Tool Search Config ────────────────────────────────────────────

/**
 * Configuration for the dynamic tool search / defer-execute mechanism.
 * When enabled and the registered tool count is large, MCP-tagged tools
 * are moved to the registry's "shadow" set and the LLM uses two new tools
 * (`tool_search`, `defer_execute_tool`) to discover and invoke them.
 *
 * See `docs/22-tool-search.md` for the full semantics.
 */
export interface ToolSearchConfig {
  /** Default: true. Setting false is equivalent to `mode: "off"`. */
  enabled?: boolean;
  /** Default: "auto". */
  mode?: "auto" | "force" | "off";
  /** Total tool count required to flip from passthrough to shadow (auto only). Default: 30. */
  threshold?: number;
  /** Tool tags whose presence makes a tool eligible for shadow. Default: ["mcp"]. */
  alwaysShadowTags?: string[];
  /** Tool tags that override `alwaysShadowTags`; never shadowed. Default: ["builtin"]. */
  alwaysActiveTags?: string[];
}

export interface ResolvedToolSearchConfig {
  enabled: boolean;
  mode: "auto" | "force" | "off";
  threshold: number;
  alwaysShadowTags: string[];
  alwaysActiveTags: string[];
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
   * - true (default): register all built-in tools (ls, read_file, write_file, edit_file, glob, grep, bash, plan, write_todos, task)
   * - false: disable all built-in tools
   * - BuiltinToolsConfig: fine-grained control via include/exclude
   */
  useBuiltinTools?: boolean | BuiltinToolsConfig;
  /**
   * Sub-agent type definitions surfaced to the parent LLM via the built-in
   * `task` tool. Each entry can be dispatched dynamically by the parent
   * model with `{ subagent_type, description, prompt }`. See
   * `docs/14-team-swarm.md#dynamic-subagenttask-工具` for the full design.
   *
   * Mutually exclusive with `SubAgentsPlugin` (from `@walle-agent/team`):
   * pick one entry point.
   */
  subAgents?: SubAgentDefinition[];
  /**
   * Macro (conversation summary) compaction config. Default: disabled. See
   * `docs/21-context-compression.md`.
   */
  macroCompression?: MacroCompressionConfig;
  /**
   * Tool search / shadow registry config. Default: enabled with `mode: "auto"`
   * and `threshold: 30`. See `docs/22-tool-search.md`.
   */
  toolSearch?: ToolSearchConfig;
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
  subAgents: SubAgentDefinition[];
  macroCompression: ResolvedMacroCompressionConfig | null;
  toolSearch: ResolvedToolSearchConfig;
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
    subAgents: config.subAgents ?? [],
    macroCompression: resolveMacroCompression(config.macroCompression),
    toolSearch: resolveToolSearch(config.toolSearch),
  };
}

function resolveMacroCompression(
  cfg: MacroCompressionConfig | undefined,
): ResolvedMacroCompressionConfig | null {
  if (!cfg) return null;
  return {
    enabled: cfg.enabled ?? false,
    threshold: cfg.threshold ?? 0.8,
    keepRecentTurns: cfg.keepRecentTurns ?? 3,
    summaryModel: cfg.summaryModel,
    summaryPrompt: cfg.summaryPrompt,
    manualOnly: cfg.manualOnly ?? false,
  };
}

function resolveToolSearch(cfg: ToolSearchConfig | undefined): ResolvedToolSearchConfig {
  const enabled = cfg?.enabled ?? true;
  const explicitMode = cfg?.mode;
  const mode: ResolvedToolSearchConfig["mode"] = !enabled
    ? "off"
    : (explicitMode ?? "auto");
  return {
    enabled,
    mode,
    threshold: cfg?.threshold ?? 30,
    alwaysShadowTags: cfg?.alwaysShadowTags ?? ["mcp"],
    alwaysActiveTags: cfg?.alwaysActiveTags ?? ["builtin"],
  };
}
