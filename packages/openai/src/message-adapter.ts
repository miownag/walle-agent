/**
 * OpenAI Message Adapter — converts between internal format and OpenAI format.
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
  TextBlock,
} from "@walle-agent/core";
import type OpenAI from "openai";

type ChatCompletionMessageParam = OpenAI.ChatCompletionMessageParam;
type ChatCompletionContentPart = OpenAI.ChatCompletionContentPart;
type ChatCompletionTool = OpenAI.ChatCompletionTool;
type ChatCompletion = OpenAI.ChatCompletion;

const SUPPORTED_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

// ─── Internal → OpenAI ─────────────────────────────────────────────

export function toOpenAIMessages(
  messages: ModelMessage[],
): ChatCompletionMessageParam[] {
  return messages.map((msg) => {
    switch (msg.role) {
      case "system":
        return {
          role: "system" as const,
          content: contentToString(msg.content),
        };

      case "user":
        return {
          role: "user" as const,
          content: userContentToOpenAI(msg.content),
        };

      case "assistant": {
        // OpenAI requires `content` to be a string or null — flatten text blocks only.
        const result: any = {
          role: "assistant" as const,
          content: contentToString(msg.content),
        };

        // Echo reasoning_content back to satisfy DeepSeek thinking-mode requirement.
        const thinking = extractThinking(msg.content);
        if (thinking) {
          result.reasoning_content = thinking;
        }

        if (msg.toolCalls?.length) {
          result.tool_calls = msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          }));
        }

        return result;
      }

      case "tool":
        return {
          role: "tool" as const,
          tool_call_id: msg.toolCallId!,
          content: contentToString(msg.content),
        };

      default:
        return {
          role: "user" as const,
          content: contentToString(msg.content),
        };
    }
  });
}

export function toOpenAITool(tool: ModelToolDefinition): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters as Record<string, unknown>,
    },
  };
}

// ─── OpenAI → Internal ─────────────────────────────────────────────

export function fromOpenAIResponse(response: ChatCompletion): LLMChatResponse {
  const choice = response.choices[0];
  if (!choice) {
    throw new Error("OpenAI response has no choices");
  }

  const msg = choice.message;
  const toolCalls: ModelToolCall[] | undefined = msg.tool_calls?.map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: JSON.parse(tc.function.arguments || "{}"),
  }));

  // DeepSeek / OpenAI thinking mode exposes `reasoning_content` on the message.
  // When present, preserve it as a ThinkingBlock so it round-trips on multi-turn.
  const reasoningContent = (msg as any).reasoning_content as string | undefined;
  const textContent = msg.content ?? undefined;

  let content: string | ContentBlock[] | undefined;
  if (reasoningContent) {
    const blocks: ContentBlock[] = [
      { type: "thinking", thinking: reasoningContent },
    ];
    if (textContent) blocks.push({ type: "text", text: textContent });
    content = blocks;
  } else {
    content = textContent;
  }

  const message: ModelMessage = {
    role: "assistant",
    content,
    toolCalls,
  };

  const usage: TokenUsage | undefined = response.usage
    ? {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
        ...(response.usage.prompt_tokens_details?.cached_tokens !== undefined
          ? {
              cacheReadTokens:
                response.usage.prompt_tokens_details.cached_tokens,
            }
          : {}),
      }
    : undefined;

  return { message, toolCalls, usage };
}

// ─── Stream Transform ──────────────────────────────────────────────

export async function* transformOpenAIStream(
  stream: AsyncIterable<OpenAI.ChatCompletionChunk>,
): AsyncGenerator<LLMStreamChunk> {
  const contentParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCallAccumulators = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();
  let completedMessage:
    | { message: ModelMessage; toolCalls?: ModelToolCall[] }
    | undefined;
  let usage: TokenUsage | undefined;

  for await (const chunk of stream) {
    // With `stream_options.include_usage`, OpenAI sends usage in a final chunk
    // whose choices array is empty. Capture it before looking up the choice and
    // defer `message_complete` until the source stream ends so callers receive
    // exactly one completion event containing the usage.
    if (chunk.usage) {
      usage = {
        promptTokens: chunk.usage.prompt_tokens,
        completionTokens: chunk.usage.completion_tokens,
        totalTokens: chunk.usage.total_tokens,
        ...(chunk.usage.prompt_tokens_details?.cached_tokens !== undefined
          ? { cacheReadTokens: chunk.usage.prompt_tokens_details.cached_tokens }
          : {}),
      };
    }

    const choice = chunk.choices[0];
    if (!choice) continue;

    const delta = choice.delta as any;

    // Reasoning / thinking delta (DeepSeek thinking mode).
    if (delta?.reasoning_content) {
      thinkingParts.push(delta.reasoning_content);
      yield { type: "thinking_delta", content: delta.reasoning_content };
    }

    // Text content
    if (delta?.content) {
      contentParts.push(delta.content);
      yield { type: "text_delta", content: delta.content };
    }

    // Tool call deltas
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        if (!toolCallAccumulators.has(idx)) {
          toolCallAccumulators.set(idx, {
            id: tc.id ?? "",
            name: tc.function?.name ?? "",
            arguments: "",
          });
        }

        const acc = toolCallAccumulators.get(idx)!;
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.arguments += tc.function.arguments;

        yield {
          type: "tool_call_delta",
          toolCallId: acc.id,
          name: tc.function?.name,
          argumentsDelta: tc.function?.arguments,
        };
      }
    }

    // Finish reason
    if (choice.finish_reason) {
      const toolCalls: ModelToolCall[] = [...toolCallAccumulators.values()].map(
        (acc) => ({
          id: acc.id,
          name: acc.name,
          arguments: JSON.parse(acc.arguments || "{}"),
        }),
      );

      const text = contentParts.join("");
      const thinking = thinkingParts.join("");

      let content: string | ContentBlock[] | undefined;
      if (thinking) {
        const blocks: ContentBlock[] = [
          { type: "thinking", thinking } satisfies ThinkingBlock,
        ];
        if (text) blocks.push({ type: "text", text } satisfies TextBlock);
        content = blocks;
      } else {
        content = text || undefined;
      }

      const message: ModelMessage = {
        role: "assistant",
        content,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      };

      completedMessage = {
        message,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      };
    }
  }

  if (completedMessage) {
    yield {
      type: "message_complete",
      ...completedMessage,
      usage,
    };
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

function userContentToOpenAI(
  content: string | ContentBlock[] | undefined,
): string | ChatCompletionContentPart[] {
  if (!content) return "";
  if (typeof content === "string") return content;

  const parts: ChatCompletionContentPart[] = [];
  let hasImage = false;

  for (const [index, block] of content.entries()) {
    if (block.type === "text") {
      if (block.text) parts.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type !== "image") continue;

    hasImage = true;
    const source = block.source;
    if (source.type === "base64") {
      assertSupportedMediaType(source.mediaType, index, "OpenAI");
      assertValidBase64(source.data, index, "OpenAI");
      parts.push({
        type: "image_url",
        image_url: {
          url: `data:${source.mediaType};base64,${source.data}`,
        },
      });
      continue;
    }

    if (source.type !== "url") {
      throw new TypeError(
        `OpenAI user image at content block ${index} has invalid source type`,
      );
    }
    assertValidImageUrl(source.url, index, "OpenAI");
    parts.push({
      type: "image_url",
      image_url: { url: source.url },
    });
  }

  // Keep the previous string representation for text-only user content.
  return hasImage ? parts : contentToString(content);
}

function assertSupportedMediaType(
  mediaType: string,
  index: number,
  provider: string,
): void {
  if (!SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType)) {
    throw new TypeError(
      `${provider} user image at content block ${index} has unsupported media type`,
    );
  }
}

function assertValidBase64(
  data: string,
  index: number,
  provider: string,
): void {
  const paddingIndex = typeof data === "string" ? data.indexOf("=") : -1;
  const unpadded = paddingIndex === -1 ? data : data.slice(0, paddingIndex);
  const padding = paddingIndex === -1 ? "" : data.slice(paddingIndex);
  const valid =
    typeof data === "string" &&
    data.length > 0 &&
    /^[A-Za-z0-9+/]+$/.test(unpadded) &&
    /^(?:|=|==)$/.test(padding) &&
    unpadded.length % 4 !== 1 &&
    (padding.length === 0 || data.length % 4 === 0) &&
    (padding.length === 0 || unpadded.length % 4 === 4 - padding.length);

  if (!valid) {
    throw new TypeError(
      `${provider} user image at content block ${index} has invalid base64 data`,
    );
  }
}

function assertValidImageUrl(
  value: string,
  index: number,
  provider: string,
): void {
  let url: URL;
  try {
    if (typeof value !== "string" || !value || value !== value.trim()) {
      throw new Error("invalid URL");
    }
    url = new URL(value);
  } catch {
    throw new TypeError(
      `${provider} user image at content block ${index} has invalid URL`,
    );
  }

  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password
  ) {
    throw new TypeError(
      `${provider} user image at content block ${index} must use an HTTP(S) URL without credentials`,
    );
  }
}

function extractThinking(content: string | ContentBlock[] | undefined): string {
  if (!content || typeof content === "string") return "";
  const thinkingBlocks = content.filter(
    (b): b is ThinkingBlock => b.type === "thinking",
  );
  return thinkingBlocks.map((b) => b.thinking).join("");
}
