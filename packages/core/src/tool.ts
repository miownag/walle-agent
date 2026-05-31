/**
 * Tool interface and helpers.
 */

import type { JSONSchema } from "./types.js";
import type { Agent } from "./agent.js";

// ─── Tool Execution Context ────────────────────────────────────────

export interface ToolExecutionContext {
  /** Current Agent instance */
  agent: Agent;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Runtime metadata */
  metadata?: Record<string, unknown>;
}

// ─── Tool Interface ────────────────────────────────────────────────

export interface Tool<TInput = any, TOutput = any> {
  /** Unique tool name (used in LLM function calling) */
  name: string;
  /** Tool description (influences LLM tool selection) */
  description: string;
  /** JSON Schema for input parameters */
  parameters: JSONSchema;
  /** Risk level for permission system */
  riskLevel?: "low" | "medium" | "high";
  /** Whether human approval is required */
  requiresApproval?: boolean;
  /** Tags for grouping/filtering */
  tags?: string[];
  /** Execute the tool */
  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;
}

// ─── Tool Call Record ──────────────────────────────────────────────

export interface ToolCallRecord {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output: unknown;
  status: "success" | "error" | "denied" | "timeout";
  durationMs?: number;
  error?: string;
}

// ─── Helper: defineTool ────────────────────────────────────────────

/**
 * Factory function for defining tools with better type inference.
 */
export function defineTool<TInput, TOutput>(
  config: Tool<TInput, TOutput>,
): Tool<TInput, TOutput> {
  return config;
}
