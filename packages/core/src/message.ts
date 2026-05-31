/**
 * Model message types — unified internal format for LLM communication.
 */

import type { JSONSchema, TokenUsage } from "./types.js";

// ─── Content Blocks ────────────────────────────────────────────────

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  source:
    | { type: "base64"; mediaType: string; data: string }
    | { type: "url"; url: string };
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string | ContentBlock[];
  isError?: boolean;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  /**
   * Provider-signed thinking block (Anthropic extended thinking).
   * Required when echoing thinking back to Anthropic for multi-turn.
   */
  signature?: string;
  /**
   * Opaque redacted thinking payload (Anthropic).
   * Carries provider-masked reasoning that still needs to round-trip.
   */
  data?: string;
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock;

// ─── Model Message ─────────────────────────────────────────────────

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | ContentBlock[];
  toolCallId?: string;
  toolCalls?: ModelToolCall[];
}

// ─── Tool Call / Definition ────────────────────────────────────────

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: JSONSchema;
  };
}
