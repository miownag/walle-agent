/**
 * LLM Provider interface — abstracts LLM vendor differences.
 */

import type { ModelMessage, ModelToolCall, ModelToolDefinition } from "./message.js";
import type { TokenUsage } from "./types.js";

// ─── Request / Response ────────────────────────────────────────────

export interface LLMChatRequest {
  messages: ModelMessage[];
  tools?: ModelToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
  responseFormat?: "text" | "json";
  /**
   * Reasoning / thinking control (per-request override).
   * - `enabled: true` turns on provider thinking mode (e.g. DeepSeek `thinking: { type: "enabled" }`,
   *   Anthropic extended thinking).
   * - `effort` controls reasoning_effort (OpenAI o-series, DeepSeek).
   */
  reasoning?: ReasoningConfig;
  /**
   * Abort signal passed through to the underlying provider. Providers SHOULD
   * forward this to their fetch / SDK call so an `agent.interrupt()` or
   * external cancel unblocks an in-flight request.
   */
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface ReasoningConfig {
  enabled?: boolean;
  effort?: "low" | "medium" | "high";
}

export interface LLMChatResponse {
  message: ModelMessage;
  toolCalls?: ModelToolCall[];
  usage?: TokenUsage;
  metadata?: Record<string, unknown>;
}

// ─── Stream Chunks ─────────────────────────────────────────────────

export type LLMStreamChunk =
  | { type: "text_delta"; content: string }
  | { type: "thinking_delta"; content: string }
  | { type: "tool_call_delta"; toolCallId: string; name?: string; argumentsDelta?: string }
  | { type: "message_complete"; message: ModelMessage; toolCalls?: ModelToolCall[]; usage?: TokenUsage }
  | { type: "error"; error: Error };

// ─── Provider Interface ────────────────────────────────────────────

export interface LLMProvider {
  /** Provider identifier */
  name: string;

  /** Non-streaming call */
  chat(request: LLMChatRequest): Promise<LLMChatResponse>;

  /** Streaming call */
  stream(request: LLMChatRequest): AsyncIterable<LLMStreamChunk>;

  /** Optional: embedding capability */
  embeddings?(input: string[]): Promise<number[][]>;

  /** Optional: token counting */
  countTokens?(messages: ModelMessage[]): Promise<number>;
}
