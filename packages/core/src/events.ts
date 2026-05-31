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
