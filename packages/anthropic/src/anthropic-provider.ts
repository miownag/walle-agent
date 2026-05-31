/**
 * Anthropic LLM Provider implementation.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMProvider,
  LLMChatRequest,
  LLMChatResponse,
  LLMStreamChunk,
} from "@walle-agent/core";
import { toAnthropicMessages, toAnthropicTool, fromAnthropicResponse, transformAnthropicStream } from "./message-adapter.js";

// ─── Config ────────────────────────────────────────────────────────

export interface AnthropicProviderConfig {
  apiKey?: string;
  model: string;
  defaultMaxTokens?: number;
  thinking?: { enabled: boolean; budgetTokens?: number };
}

// ─── Provider ──────────────────────────────────────────────────────

export class AnthropicProvider implements LLMProvider {
  name = "anthropic";
  private client: Anthropic;
  private model: string;
  private defaultMaxTokens: number;
  private thinking?: { enabled: boolean; budgetTokens?: number };

  constructor(config: AnthropicProviderConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey ?? process.env.ANTHROPIC_API_KEY,
    });
    this.model = config.model;
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096;
    this.thinking = config.thinking;
  }

  async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    const { system, messages } = toAnthropicMessages(request.messages);
    const tools = request.tools?.map(toAnthropicTool);

    const params: any = {
      model: this.model,
      messages,
      max_tokens: request.maxTokens ?? this.defaultMaxTokens,
    };

    if (system) params.system = system;
    if (tools?.length) params.tools = tools;
    if (request.temperature !== undefined) params.temperature = request.temperature;
    if (request.topP !== undefined) params.top_p = request.topP;
    if (request.stop) params.stop_sequences = request.stop;

    if (this.thinking?.enabled) {
      params.thinking = {
        type: "enabled",
        budget_tokens: this.thinking.budgetTokens ?? 10000,
      };
    }

    const response = await this.client.messages.create(params);
    return fromAnthropicResponse(response as Anthropic.Message);
  }

  async *stream(request: LLMChatRequest): AsyncIterable<LLMStreamChunk> {
    const { system, messages } = toAnthropicMessages(request.messages);
    const tools = request.tools?.map(toAnthropicTool);

    const params: any = {
      model: this.model,
      messages,
      max_tokens: request.maxTokens ?? this.defaultMaxTokens,
      stream: true,
    };

    if (system) params.system = system;
    if (tools?.length) params.tools = tools;
    if (request.temperature !== undefined) params.temperature = request.temperature;
    if (request.topP !== undefined) params.top_p = request.topP;
    if (request.stop) params.stop_sequences = request.stop;

    if (this.thinking?.enabled) {
      params.thinking = {
        type: "enabled",
        budget_tokens: this.thinking.budgetTokens ?? 10000,
      };
    }

    const stream = this.client.messages.stream(params);

    yield* transformAnthropicStream(stream);
  }
}
