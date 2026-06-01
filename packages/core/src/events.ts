/**
 * EventBus — typed async event system.
 */

import type { ModelMessage, ModelToolCall } from "./message.js";
import type { ToolCallRecord } from "./tool.js";
import type { AgentInput } from "./agent-config.js";

// ─── Run Status ────────────────────────────────────────────────────

export type RunStatus = "completed" | "user-cancelled" | "error";

// ─── Event Map ─────────────────────────────────────────────────────

export interface AgentEventMap {
  run_start: { input: AgentInput; runId: string; sessionId?: string };
  run_end: {
    messages: ModelMessage[];
    runId: string;
    sessionId?: string;
    status: RunStatus;
    error?: unknown;
  };
  model_call_start: { messages: ModelMessage[] };
  model_call_end: { message: ModelMessage };
  tool_call_start: { call: ModelToolCall };
  tool_call_end: { record: ToolCallRecord };
  /**
   * Collect conversation history from plugins before building the prompt.
   * Plugins push prior `ModelMessage[]` into `into` (usually loaded from a session store).
   */
  collect_messages: { sessionId?: string; into: ModelMessage[] };
  collect_context: { query: string; items: ContextItem[] };
  /**
   * Emitted by `AgentRuntime` at the top of each turn, before
   * `model.stream(...)`. Listeners (typically `MemoryPlugin`) MAY mutate
   * `messages` in place — usually to rewrite older `role: "tool"` payloads
   * into placeholders ("micro" compression). Idempotent: an already-evicted
   * tool message should be left as-is or re-rendered, not mutated again.
   */
  compact_messages: {
    messages: ModelMessage[];
    keepRecentTurns: number;
    runId: string;
    sessionId?: string;
  };
  /**
   * Emitted after a successful macro compression pass.
   */
  compaction_done: {
    runId: string;
    sessionId?: string;
    /** Message count BEFORE compression. */
    before: number;
    /** Message count AFTER compression. */
    after: number;
    /** The summary text inserted as a synthesised user message. */
    summary: string;
  };
  /**
   * Emitted by the built-in `read_tool_result` tool. Listeners with vault
   * access (e.g. `MemoryPlugin`) write the slice into `result.value`. If
   * nothing writes, the tool reports the vault as unavailable.
   */
  vault_read: {
    toolCallId: string;
    offset: number;
    limit: number;
    result: {
      value?:
        | { content: string; totalLines: number; truncated: boolean }
        | { error: string };
    };
  };
  /**
   * Emitted by the built-in `tool_search` tool after computing matches.
   */
  tool_search_done: {
    keywords: string[];
    matches: Array<{
      server: string;
      qualifiedName: string;
      toolName: string;
      description: string;
      score: number;
      shadowed: boolean;
    }>;
    totalCandidates: number;
  };
  /**
   * Emitted by the built-in `defer_execute_tool` after delegating execution.
   */
  tool_defer_executed: {
    qualifiedName: string;
    status: "success" | "error" | "denied";
    durationMs: number;
  };
  memory_write: { item: unknown };
  skill_write: { skill: unknown };
  evolution_proposal: { type: "memory" | "skill"; proposal: unknown };
}

// ─── Context Item ──────────────────────────────────────────────────

export interface ContextItem {
  /** Source plugin name */
  source: string;
  /** Priority — higher = less likely to be trimmed by token budget */
  priority: number;
  /** Content to inject into prompt */
  content: string;
  /** Estimated token count */
  estimatedTokens?: number;
  /** Metadata */
  metadata?: Record<string, unknown>;
}

// ─── EventBus ──────────────────────────────────────────────────────

export class EventBus {
  private listeners = new Map<string, Set<Function>>();

  on<K extends keyof AgentEventMap>(
    event: K,
    handler: (payload: AgentEventMap[K]) => Promise<void> | void,
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
    return () => {
      this.listeners.get(event)?.delete(handler);
    };
  }

  async emit<K extends keyof AgentEventMap>(
    event: K,
    payload: AgentEventMap[K],
  ): Promise<void> {
    const handlers = this.listeners.get(event);
    if (!handlers) return;

    await Promise.all([...handlers].map((handler) => handler(payload)));
  }
}
