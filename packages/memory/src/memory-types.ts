/**
 * Data shapes exchanged by the memory plugin.
 */

import type { ModelMessage, ToolCallRecord } from "@walle-agent/core";

// ─── Session log ────────────────────────────────────────────────────

/** One JSONL line in `<session>/messages.jsonl`. */
export interface SessionMessageRecord {
  runId: string;
  /** Monotonic index within the run (0-based). */
  turn: number;
  /** ISO timestamp when the message was logged. */
  timestamp: string;
  message: ModelMessage;
}

/** One JSONL line in `<session>/runs.jsonl`. Written twice: on start + on end. */
export interface SessionRunRecord {
  runId: string;
  sessionId: string;
  startAt?: string;
  endAt?: string;
  status?: "completed" | "user-cancelled" | "error";
  error?: string;
}

// ─── Tool result eviction ───────────────────────────────────────────

export const EVICTED_TOOL_RESULT_KIND = "walle.evicted-tool-result" as const;

/**
 * Envelope serialized into a tool `ModelMessage.content` (as JSON string)
 * when the original output was too large.
 */
export interface EvictedToolResult {
  _kind: typeof EVICTED_TOOL_RESULT_KIND;
  toolCallId: string;
  toolName: string;
  /** Absolute path to the dumped `.txt` file. */
  path: string;
  /** Size in characters of the original payload. */
  size: number;
  /** Head + tail preview with a truncation marker in between. */
  preview: string;
  evictedAt: string;
}

/** Sidecar metadata written next to the `.txt` file. */
export interface EvictedToolResultMeta extends EvictedToolResult {
  /** Original tool record status (success / error / denied / timeout). */
  status?: ToolCallRecord["status"];
}

// ─── Long-term memory ───────────────────────────────────────────────

export type MemoryScope = "short" | "mid" | "long";

export type MemoryType =
  | "fact"
  | "preference"
  | "summary"
  | "procedure"
  | "profile"
  | "decision"
  | "warning";

export interface MemoryItem {
  id: string;
  scope: MemoryScope;
  type: MemoryType;
  content: string;
  /** Importance 0..1. */
  importance: number;
  /** Confidence 0..1. */
  confidence: number;
  userId?: string;
  sessionId?: string;
  tags?: string[];
  createdAt: string;
  updatedAt?: string;
  expiresAt?: string;
  source?: {
    conversationId?: string;
    messageIds?: string[];
    toolCallIds?: string[];
  };
}

export interface MemoryQuery {
  text?: string;
  scope?: MemoryScope;
  types?: MemoryType[];
  userId?: string;
  sessionId?: string;
  topK?: number;
}

export interface MemoryRetrieveOptions {
  longTopK?: number;
  midTopK?: number;
  userId?: string;
  sessionId?: string;
}

// ─── Plugin config ──────────────────────────────────────────────────

export interface MemoryPluginConfig {
  /** Root directory for all memory artefacts. Default: `./.walle`. */
  rootDir?: string;

  sessions?: {
    /** Default: true. */
    enabled?: boolean;
    /** Override the default `<rootDir>/sessions`. */
    dir?: string;
  };

  /**
   * @deprecated Renamed to `toolResults`. The legacy field is still accepted
   * (with a one-shot console warning) and merged into `toolResults` semantics.
   */
  largeToolResults?: {
    /** Default: true. */
    enabled?: boolean;
    /** Override the default `<rootDir>/memory/large-tool-results`. */
    dir?: string;
    /** Character threshold over which a tool result is evicted. Default: 0 (always). */
    thresholdChars?: number;
    /** Lines of the head preview. Default: 10. */
    previewHeadLines?: number;
    /** Lines of the tail preview. Default: 10. */
    previewTailLines?: number;
  };

  /**
   * Tool result vault configuration. Drives both the legacy "evict large
   * outputs to disk" behaviour and the new turn-based "micro" context
   * compression — see `docs/21-context-compression.md`.
   */
  toolResults?: {
    /** Default: true. */
    enabled?: boolean;
    /** Override the default `<rootDir>/memory/large-tool-results`. */
    dir?: string;
    /** Character threshold over which a tool result is evicted. 0 = always. Default: 0. */
    thresholdChars?: number;
    /** How many recent assistant turns to leave verbatim before eviction kicks in. Default: 3. */
    keepRecentTurns?: number;
    /** Lines of the head preview. Default: 10. */
    previewHeadLines?: number;
    /** Lines of the tail preview. Default: 10. */
    previewTailLines?: number;
  };

  longTerm?: {
    /** Default: true. */
    enabled?: boolean;
    /** Override the default `<rootDir>/memory/memories.jsonl`. */
    filePath?: string;
    /** Top-K items to inject into `collect_context`. Default: 8. */
    topK?: number;
    /** Jaccard similarity threshold for dedup. Default: 0.8. */
    dedupThreshold?: number;
  };
}
