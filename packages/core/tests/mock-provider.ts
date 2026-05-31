/**
 * Mock LLM Provider for testing.
 */

import type {
  LLMProvider,
  LLMChatRequest,
  LLMChatResponse,
  LLMStreamChunk,
  ModelMessage,
  ModelToolCall,
} from "../../core/src/index.js";

export interface MockProviderResponse {
  content?: string;
  toolCalls?: ModelToolCall[];
}

export class MockProvider implements LLMProvider {
  name = "mock";
  private responses: MockProviderResponse[];
  private callIndex = 0;
  public calls: LLMChatRequest[] = [];

  constructor(responses: MockProviderResponse[]) {
    this.responses = responses;
  }

  async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    this.calls.push(request);
    const response = this.responses[this.callIndex] ?? { content: "default response" };
    this.callIndex++;

    const message: ModelMessage = {
      role: "assistant",
      content: response.content,
      toolCalls: response.toolCalls,
    };

    return { message, toolCalls: response.toolCalls };
  }

  async *stream(request: LLMChatRequest): AsyncIterable<LLMStreamChunk> {
    this.calls.push(request);
    const response = this.responses[this.callIndex] ?? { content: "default response" };
    this.callIndex++;

    // Emit text deltas character by character
    if (response.content) {
      for (const char of response.content) {
        yield { type: "text_delta", content: char };
      }
    }

    // Emit tool call deltas
    if (response.toolCalls) {
      for (const tc of response.toolCalls) {
        yield {
          type: "tool_call_delta",
          toolCallId: tc.id,
          name: tc.name,
          argumentsDelta: JSON.stringify(tc.arguments),
        };
      }
    }

    // Emit message_complete
    const message: ModelMessage = {
      role: "assistant",
      content: response.content,
      toolCalls: response.toolCalls,
    };

    yield {
      type: "message_complete",
      message,
      toolCalls: response.toolCalls,
    };
  }
}
