/**
 * Anthropic Message Adapter — converts between internal format and Anthropic format.
 */

import type {
  ModelMessage,
  ModelToolCall,
  ContentBlock,
  LLMChatResponse,
  LLMStreamChunk,
  ModelToolDefinition,
  TokenUsage,
  ThinkingBlock,
} from "@walle-agent/core";
import type Anthropic from "@anthropic-ai/sdk";

type MessageParam = Anthropic.MessageParam;
type ContentBlockParam = Anthropic.ContentBlockParam;
type Tool = Anthropic.Tool;
type Message = Anthropic.Message;

// ─── Internal → Anthropic ──────────────────────────────────────────

export function toAnthropicMessages(messages: ModelMessage[]): {
  system: string | undefined;
  messages: MessageParam[];
} {
  let system: string | undefined;
  const result: MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      system = contentToString(msg.content);
      continue;
    }

    if (msg.role === "user") {
      result.push({
        role: "user",
        content: contentToString(msg.content),
      });
      continue;
    }

    if (msg.role === "assistant") {
      const contentBlocks: ContentBlockParam[] = [];

      // Preserve signed / redacted thinking blocks first — Anthropic extended
      // thinking requires the original thinking blocks to be echoed back in
      // multi-turn. Unsigned thinking is safe to drop.
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "thinking") {
            const tb = block as ThinkingBlock;
            if (tb.data) {
              // redacted thinking
              contentBlocks.push({
                type: "redacted_thinking",
                data: tb.data,
              } as ContentBlockParam);
            } else if (tb.signature) {
              contentBlocks.push({
                type: "thinking",
                thinking: tb.thinking,
                signature: tb.signature,
              } as ContentBlockParam);
            }
            // unsigned → drop, Anthropic rejects unsigned thinking on resume
          }
        }
      }

      // Add text content
      const text = contentToString(msg.content);
      if (text) {
        contentBlocks.push({ type: "text", text });
      }

      // Add tool_use blocks
      if (msg.toolCalls?.length) {
        for (const tc of msg.toolCalls) {
          contentBlocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        }
      }

      result.push({
        role: "assistant",
        content: contentBlocks.length > 0 ? contentBlocks : text,
      });
      continue;
    }

    if (msg.role === "tool") {
      // Anthropic: tool results go in user messages
      result.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.toolCallId!,
            content: contentToString(msg.content),
          },
        ],
      });
      continue;
    }
  }

  return { system, messages: result };
}

export function toAnthropicTool(tool: ModelToolDefinition): Tool {
  return {
    name: tool.function.name,
    description: tool.function.description ?? "",
    input_schema: tool.function.parameters as Tool["input_schema"],
  };
}

// ─── Anthropic → Internal ──────────────────────────────────────────

export function fromAnthropicResponse(response: Message): LLMChatResponse {
  const toolCalls: ModelToolCall[] = [];
  const contentBlocks: ContentBlock[] = [];

  for (const block of response.content) {
    if (block.type === "text") {
      contentBlocks.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: block.input as Record<string, unknown>,
      });
      contentBlocks.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      });
    } else if (block.type === "thinking") {
      const raw = block as any;
      contentBlocks.push({
        type: "thinking",
        thinking: raw.thinking ?? "",
        signature: raw.signature,
      });
    } else if ((block as any).type === "redacted_thinking") {
      const raw = block as any;
      contentBlocks.push({
        type: "thinking",
        thinking: "",
        data: raw.data,
      });
    }
  }

  const textContent = contentBlocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");

  // Preserve thinking blocks in content if present so multi-turn round-trips correctly.
  const hasThinking = contentBlocks.some((b) => b.type === "thinking");
  const messageContent: string | ContentBlock[] | undefined = hasThinking
    ? contentBlocks.filter((b) => b.type === "thinking" || b.type === "text")
    : textContent || undefined;

  const message: ModelMessage = {
    role: "assistant",
    content: messageContent,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };

  const usage: TokenUsage = {
    promptTokens: response.usage.input_tokens,
    completionTokens: response.usage.output_tokens,
    totalTokens: response.usage.input_tokens + response.usage.output_tokens,
    cacheReadTokens: (response.usage as any).cache_read_input_tokens,
    cacheWriteTokens: (response.usage as any).cache_creation_input_tokens,
  };

  return { message, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, usage };
}

// ─── Stream Transform ──────────────────────────────────────────────

export async function* transformAnthropicStream(
  stream: AsyncIterable<Anthropic.MessageStreamEvent>,
): AsyncGenerator<LLMStreamChunk> {
  const contentParts: string[] = [];
  const thinkingAccumulators: Array<{ thinking: string; signature?: string; data?: string }> = [];
  let currentThinkingIndex: number | null = null;
  const toolCallAccumulators = new Map<
    string,
    { id: string; name: string; arguments: string }
  >();
  let currentToolUseId: string | null = null;
  let usage: TokenUsage | undefined;

  for await (const event of stream) {
    switch (event.type) {
      case "content_block_start": {
        const block = event.content_block;
        if (block.type === "tool_use") {
          currentToolUseId = block.id;
          toolCallAccumulators.set(block.id, {
            id: block.id,
            name: block.name,
            arguments: "",
          });
          yield {
            type: "tool_call_delta",
            toolCallId: block.id,
            name: block.name,
          };
        } else if (block.type === "thinking") {
          currentThinkingIndex = thinkingAccumulators.length;
          thinkingAccumulators.push({ thinking: "" });
        } else if ((block as any).type === "redacted_thinking") {
          thinkingAccumulators.push({ thinking: "", data: (block as any).data });
        }
        break;
      }

      case "content_block_delta": {
        const delta = event.delta as any;
        if (delta.type === "text_delta") {
          contentParts.push(delta.text);
          yield { type: "text_delta", content: delta.text };
        } else if (delta.type === "input_json_delta") {
          if (currentToolUseId) {
            const acc = toolCallAccumulators.get(currentToolUseId);
            if (acc) {
              acc.arguments += delta.partial_json;
              yield {
                type: "tool_call_delta",
                toolCallId: currentToolUseId,
                argumentsDelta: delta.partial_json,
              };
            }
          }
        } else if (delta.type === "thinking_delta") {
          const text = delta.thinking ?? "";
          if (currentThinkingIndex !== null) {
            thinkingAccumulators[currentThinkingIndex]!.thinking += text;
          }
          yield { type: "thinking_delta", content: text };
        } else if (delta.type === "signature_delta") {
          if (currentThinkingIndex !== null) {
            const acc = thinkingAccumulators[currentThinkingIndex]!;
            acc.signature = (acc.signature ?? "") + (delta.signature ?? "");
          }
        }
        break;
      }

      case "content_block_stop": {
        currentToolUseId = null;
        currentThinkingIndex = null;
        break;
      }

      case "message_delta": {
        // Message-level updates (stop_reason, usage)
        if ((event as any).usage) {
          const u = (event as any).usage;
          usage = {
            promptTokens: 0, // filled from message_start
            completionTokens: u.output_tokens ?? 0,
            totalTokens: u.output_tokens ?? 0,
          };
        }
        break;
      }

      case "message_start": {
        if (event.message.usage) {
          const u = event.message.usage;
          usage = {
            promptTokens: u.input_tokens,
            completionTokens: u.output_tokens,
            totalTokens: u.input_tokens + u.output_tokens,
          };
        }
        break;
      }

      case "message_stop": {
        const toolCalls: ModelToolCall[] = [...toolCallAccumulators.values()].map((acc) => ({
          id: acc.id,
          name: acc.name,
          arguments: JSON.parse(acc.arguments || "{}"),
        }));

        const text = contentParts.join("");
        const thinkingBlocks: ThinkingBlock[] = thinkingAccumulators
          .filter((a) => a.thinking || a.data)
          .map((a) => ({
            type: "thinking",
            thinking: a.thinking,
            signature: a.signature,
            data: a.data,
          }));

        let content: string | ContentBlock[] | undefined;
        if (thinkingBlocks.length > 0) {
          const blocks: ContentBlock[] = [...thinkingBlocks];
          if (text) blocks.push({ type: "text", text });
          content = blocks;
        } else {
          content = text || undefined;
        }

        const message: ModelMessage = {
          role: "assistant",
          content,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        };

        yield {
          type: "message_complete",
          message,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          usage,
        };
        break;
      }
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

function contentToString(content: string | ContentBlock[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}
