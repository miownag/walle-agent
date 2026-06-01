/**
 * SubAgentRegistry — runtime registry for dynamic sub-agent types.
 *
 * Each Agent owns one registry; the built-in `task` tool consults it to
 * resolve `subagent_type` → SubAgentDefinition at run time.
 *
 * See `docs/14-team-swarm.md#dynamic-subagenttask-工具` for the full
 * spec.
 */

import type { LLMProvider } from "./llm-provider.js";
import type { Tool } from "./tool.js";
import type { WallePlugin } from "./plugin.js";
import type { BuiltinToolsConfig } from "./agent-config.js";

// ─── SubAgentDefinition ────────────────────────────────────────────

export interface SubAgentDefinition {
  /** Unique type key — used as the `subagent_type` argument to the task tool. */
  type: string;
  /**
   * Free-text description surfaced to the parent LLM in the task tool's
   * `subagent_type` description. Influences when the LLM picks this type.
   */
  description?: string;
  /** SystemPrompt for the sub-agent. */
  systemPrompt?: string;
  /**
   * Override the model used for this sub-agent. Defaults to the parent
   * agent's `model` (or whatever `defaultModel` was passed to
   * `createTaskTool`).
   */
  model?: LLMProvider;
  /** Native tools registered on the sub-agent. Defaults to []. */
  tools?: Tool[];
  /**
   * Built-in tool config for the sub-agent. Defaults to `false` (no
   * built-ins) to prevent accidental task-tool recursion. Pass an explicit
   * include list (e.g. `{ includeTools: ["read_file", "task"] }`) to opt
   * in.
   */
  useBuiltinTools?: boolean | BuiltinToolsConfig;
  /** Plugins forwarded to `Agent.create` for the sub-agent. */
  plugins?: WallePlugin[];
  /** Override `maxTurns`. Defaults to the parent agent's `maxTurns`. */
  maxTurns?: number;
  /**
   * When false (default), the task tool returns `{ result }` only — sub-agent
   * messages and toolCalls are hidden from the parent. When true, the full
   * `{ result, messages, toolCalls }` payload is returned.
   */
  verbose?: boolean;
  /**
   * When true, the sub-agent reuses the parent's `sessionId` (memory plugins
   * see the same conversation). Default false → independent session, no
   * cross-contamination.
   */
  inheritSession?: boolean;
}

// ─── SubAgentRegistry ──────────────────────────────────────────────

export class SubAgentRegistry {
  private defs = new Map<string, SubAgentDefinition>();

  /**
   * Register a sub-agent type. Throws if `def.type` is already registered —
   * silent overrides would make wrong-type bugs untraceable.
   */
  register(def: SubAgentDefinition): void {
    if (!def.type || typeof def.type !== "string") {
      throw new Error("SubAgentRegistry.register: def.type must be a non-empty string");
    }
    if (this.defs.has(def.type)) {
      throw new Error(
        `SubAgentRegistry.register: type "${def.type}" is already registered. ` +
          "Use a different type name or unregister the existing one first.",
      );
    }
    this.defs.set(def.type, def);
  }

  /** Remove a registered type. Returns true if it existed. */
  unregister(type: string): boolean {
    return this.defs.delete(type);
  }

  get(type: string): SubAgentDefinition | undefined {
    return this.defs.get(type);
  }

  has(type: string): boolean {
    return this.defs.has(type);
  }

  list(): SubAgentDefinition[] {
    return [...this.defs.values()];
  }

  types(): string[] {
    return [...this.defs.keys()];
  }

  /** Number of registered types. */
  get size(): number {
    return this.defs.size;
  }
}
