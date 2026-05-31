/**
 * OpenAI LLM Provider implementation.
 */

import OpenAI from "openai";
import type {
  LLMProvider,
  LLMChatRequest,
  LLMChatResponse,
  LLMStreamChunk,
  ReasoningConfig,
} from "@walle-agent/core";
import { toOpenAIMessages, toOpenAITool, fromOpenAIResponse, transformOpenAIStream } from "./message-adapter.js";

// ─── Config ────────────────────────────────────────────────────────

export interface OpenAIProviderConfig {
  apiKey?: string;
  baseURL?: string;
  model: string;
  organization?: string;
  defaultTemperature?: number;
  defaultMaxTokens?: number;
  /**
   * Default reasoning / thinking control for every request.
   * Can be overridden per-request via `LLMChatRequest.reasoning`.
   *
   * - `enabled: true` sends `thinking: { type: "enabled" }` (DeepSeek-compatible).
   * - `effort` sends `reasoning_effort` (OpenAI o-series / DeepSeek).
   */
  reasoning?: ReasoningConfig;
}

// ─── Provider ──────────────────────────────────────────────────────

export class OpenAIProvider implements LLMProvider {
  name = "openai";
  private client: OpenAI;
  private model: string;
  private defaultTemperature?: number;
  private defaultMaxTokens?: number;
  private reasoning?: ReasoningConfig;

  constructor(config: OpenAIProviderConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey ?? process.env.OPENAI_API_KEY,
      baseURL: config.baseURL,
      organization: config.organization,
    });
    this.model = config.model;
    this.defaultTemperature = config.defaultTemperature;
    this.defaultMaxTokens = config.defaultMaxTokens;
    this.reasoning = config.reasoning;
  }

  async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    const messages = toOpenAIMessages(request.messages);
    const tools = request.tools?.map(toOpenAITool);

    const params = {
      model: this.model,
      messages,
      tools: tools?.length ? tools : undefined,
      temperature: request.temperature ?? this.defaultTemperature,
      max_tokens: request.maxTokens ?? this.defaultMaxTokens,
      top_p: request.topP,
      stop: request.stop,
      ...this.buildReasoningExtras(request.reasoning),
    };

    const response = await this.client.chat.completions.create(params as any);

    return fromOpenAIResponse(response);
  }

  async *stream(request: LLMChatRequest): AsyncIterable<LLMStreamChunk> {
    const messages = toOpenAIMessages(request.messages);
    const tools = request.tools?.map(toOpenAITool);

    const params = {
      model: this.model,
      messages,
      tools: tools?.length ? tools : undefined,
      temperature: request.temperature ?? this.defaultTemperature,
      max_tokens: request.maxTokens ?? this.defaultMaxTokens,
      top_p: request.topP,
      stop: request.stop,
      stream: true,
      stream_options: { include_usage: true },
      ...this.buildReasoningExtras(request.reasoning),
    };

    const stream = await this.client.chat.completions.create(params as any);

    yield* transformOpenAIStream(stream as any);
  }

  /**
   * Merge provider-default reasoning config with per-request override and
   * emit the vendor-specific keys (`thinking`, `reasoning_effort`).
   */
  private buildReasoningExtras(perRequest?: ReasoningConfig): Record<string, unknown> {
    const r = perRequest ?? this.reasoning;
    if (!r) return {};

    const extras: Record<string, unknown> = {};
    if (r.enabled) extras.thinking = { type: "enabled" };
    if (r.effort) extras.reasoning_effort = r.effort;
    return extras;
  }
}
