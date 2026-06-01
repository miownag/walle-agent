/**
 * Message compaction primitives.
 *
 * Pure functions used by:
 *  - `MemoryPlugin` to rewrite old `role: "tool"` messages into placeholders
 *    when handling the `compact_messages` event (micro compression).
 *  - `AgentRuntime` to find the protected tail when running macro compression.
 *
 * No I/O, no LLM — purely structural slicing of `ModelMessage[]`.
 */

import type { ModelMessage } from "./message.js";

/**
 * Result of `partitionByTurns`. The Sets contain **indices** into the input
 * `messages` array.
 *
 * - `keepIndices` — indices to keep verbatim (always includes every system
 *   message, plus the most recent N assistant turns and everything after them).
 * - `evictableIndices` — complement of `keepIndices`. Tool messages here are
 *   the ones micro compression rewrites; the same set defines macro
 *   compression's `head` region.
 * - `turnStarts` — indices of every `role: "assistant"` message (oldest →
 *   newest). Useful for callers that want to inspect the partition.
 */
export interface PartitionResult {
  keepIndices: Set<number>;
  evictableIndices: Set<number>;
  turnStarts: number[];
}

/**
 * Partition `messages` by **assistant turn**. Each `role: "assistant"`
 * message starts a turn, and all subsequent non-assistant messages (tool
 * results, follow-up assistant text bound to the same call etc.) belong to
 * that turn.
 *
 * The most recent `keepRecentTurns` assistant turns are protected — every
 * message at or after the start of the oldest protected turn is kept.
 * System messages are always kept regardless of position.
 *
 * If there are fewer than `keepRecentTurns` assistant turns, every message
 * is kept and `evictableIndices` is empty.
 */
export function partitionByTurns(
  messages: ModelMessage[],
  keepRecentTurns: number,
): PartitionResult {
  const turnStarts: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "assistant") turnStarts.push(i);
  }

  const keep = new Set<number>();
  const evictable = new Set<number>();

  // System messages are always kept.
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "system") keep.add(i);
  }

  if (keepRecentTurns <= 0) {
    // Force-evict-everything mode (used by macro for "summarize all but tail").
    for (let i = 0; i < messages.length; i++) {
      if (!keep.has(i)) evictable.add(i);
    }
    return { keepIndices: keep, evictableIndices: evictable, turnStarts };
  }

  if (turnStarts.length === 0 || turnStarts.length <= keepRecentTurns) {
    // No assistant turns yet, OR fewer turns than the protection window →
    // keep everything (protection covers the whole conversation).
    for (let i = 0; i < messages.length; i++) keep.add(i);
    return { keepIndices: keep, evictableIndices: evictable, turnStarts };
  }

  const cutoff = turnStarts[turnStarts.length - keepRecentTurns];
  for (let i = 0; i < messages.length; i++) {
    if (i >= cutoff) keep.add(i);
    else if (!keep.has(i)) evictable.add(i);
  }

  return { keepIndices: keep, evictableIndices: evictable, turnStarts };
}

// ─── Placeholder text ──────────────────────────────────────────────

export interface PlaceholderInput {
  /** Monotonic vault index, surfaced to the LLM for human-friendly references. */
  idx: number;
  toolName: string;
  toolCallId: string;
  /** Original payload size, in characters. */
  size: number;
  /** Absolute path of the dumped file, if available. */
  vaultPath?: string;
  /** Head + tail preview. */
  preview: string;
}

/**
 * Sentinel prefix used to detect already-rewritten tool messages. The full
 * placeholder text always starts with this constant.
 */
export const TOOL_RESULT_PLACEHOLDER_PREFIX = "[ToolResult #";

/** Build the placeholder text the LLM sees in place of an evicted tool result. */
export function buildPlaceholder(p: PlaceholderInput): string {
  const header = `${TOOL_RESULT_PLACEHOLDER_PREFIX}${p.idx} evicted | tool=${p.toolName} | toolCallId=${p.toolCallId} | size=${p.size} chars]`;
  const hint = p.vaultPath
    ? `Use read_tool_result(toolCallId="${p.toolCallId}") or read_file(path="${p.vaultPath}") to load the full content.`
    : `Use read_tool_result(toolCallId="${p.toolCallId}") to load the full content.`;
  return `${header}\n${hint}\n\n${p.preview}`;
}

/** Cheap detection of placeholder content — used to short-circuit re-eviction. */
export function isPlaceholder(content: unknown): boolean {
  return typeof content === "string" && content.startsWith(TOOL_RESULT_PLACEHOLDER_PREFIX);
}
