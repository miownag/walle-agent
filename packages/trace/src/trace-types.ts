/**
 * Public types for `@walle-agent/trace`.
 *
 * `TraceEvent` is the canonical record produced by the plugin and consumed
 * by `TraceStore` implementations. The event type space is intentionally
 * stable — Phase-6 evolution machinery treats this as a public contract.
 */

export type TraceEventType =
  | "run_start"
  | "run_end"
  | "run_error"
  | "model_call_start"
  | "model_call_end"
  | "tool_call_start"
  | "tool_call_end"
  | "memory_read"
  | "memory_write"
  | "skill_read"
  | "skill_write"
  | "evolution_trigger"
  | "evolution_proposal"
  | "permission_check"
  | "context_collect";

export interface TraceEvent {
  /** Per-event UUID. */
  id: string;
  /** Stable id for the run that produced this event. */
  traceId: string;
  /** Optional parent for nested spans. */
  parentId?: string;
  type: TraceEventType;
  /** ISO-8601. */
  timestamp: string;
  /** Optional duration for span-style events. */
  durationMs?: number;
  /** Event-type-specific payload. */
  data: Record<string, unknown>;
  /** Free-form attributes (sessionId, userId, etc.). */
  metadata?: Record<string, unknown>;
}

export interface TraceQuery {
  traceId?: string;
  types?: TraceEventType[];
  /** ISO-8601 lower bound (inclusive). */
  since?: string;
  /** ISO-8601 upper bound (inclusive). */
  until?: string;
  limit?: number;
}

export interface TraceStore {
  write(event: TraceEvent): Promise<void>;
  query(options: TraceQuery): Promise<TraceEvent[]>;
  getTrace(traceId: string): Promise<TraceEvent[]>;
  /** Optional release. JSONLTraceStore is a no-op. */
  dispose?(): Promise<void>;
}

export interface TracePluginConfig {
  /** Backend selector. Default `"jsonl"`. */
  store?: "jsonl" | "memory";
  /** Directory for JSONL backend. Default `"./.walle/traces"`. */
  storePath?: string;
  /** OTEL adapter is shipped separately; the type is reserved. */
  otel?: { enabled: boolean; endpoint?: string; serviceName?: string };
  /**
   * If `true`, recorded `data` includes raw text/arguments. Default `false`
   * (treats every payload as potentially sensitive).
   */
  recordContent?: boolean;
  /** 0..1; default 1. Random per-event drop. */
  sampleRate?: number;
  /**
   * Provide a pre-built store directly. Wins over `store`/`storePath`. Useful
   * for tests and for shipping a custom adapter (e.g. OTEL) without forking
   * the plugin.
   */
  customStore?: TraceStore;
}
