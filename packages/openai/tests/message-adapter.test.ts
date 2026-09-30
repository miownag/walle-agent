/**
 * OpenAI message-adapter tests — focus on reasoning_content / thinking round-trip.
 */

import { describe, it, expect } from "vitest";
import type OpenAI from "openai";
import {
  fromOpenAIResponse,
  toOpenAIMessages,
  transformOpenAIStream,
} from "../src/message-adapter.js";
import type {
  ContentBlock,
  LLMStreamChunk,
  ModelMessage,
  ThinkingBlock,
} from "@walle-agent/core";

function makeChunk(
  delta: Record<string, any>,
  finish = false,
  usage?: any,
): OpenAI.ChatCompletionChunk {
  return {
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model: "deepseek-v4-pro",
    choices: [
      {
        index: 0,
        delta: delta as any,
        finish_reason: finish ? "stop" : null,
      } as any,
    ],
    usage,
  } as any;
}

describe("OpenAI message-adapter — reasoning_content handling", () => {
  it("fromOpenAIResponse preserves reasoning_content as ThinkingBlock", () => {
    const resp = {
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "the answer is 42",
            reasoning_content: "Let me think about this...",
          } as any,
        } as any,
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    } as any;

    const result = fromOpenAIResponse(resp);
    expect(Array.isArray(result.message.content)).toBe(true);
    const blocks = result.message.content as ContentBlock[];
    expect(blocks[0]).toEqual({
      type: "thinking",
      thinking: "Let me think about this...",
    });
    expect(blocks[1]).toEqual({ type: "text", text: "the answer is 42" });
  });

  it("fromOpenAIResponse falls back to string content when no reasoning_content", () => {
    const resp = {
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "hi" } as any,
        } as any,
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    } as any;

    const result = fromOpenAIResponse(resp);
    expect(result.message.content).toBe("hi");
  });

  it("preserves cached prompt tokens from a non-streaming response", () => {
    const response = {
      choices: [{ message: { role: "assistant", content: "done" } }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 5,
        total_tokens: 105,
        prompt_tokens_details: { cached_tokens: 64 },
      },
    } as any;
    expect(fromOpenAIResponse(response).usage).toMatchObject({
      promptTokens: 100,
      cacheReadTokens: 64,
    });
  });

  it("toOpenAIMessages round-trips reasoning_content via assistant ThinkingBlock", () => {
    const history: ModelMessage[] = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "user said hi, reply",
          } satisfies ThinkingBlock,
          { type: "text", text: "hi!" },
        ],
      },
    ];

    const mapped = toOpenAIMessages(history) as any[];
    expect(mapped[1].role).toBe("assistant");
    expect(mapped[1].content).toBe("hi!");
    expect(mapped[1].reasoning_content).toBe("user said hi, reply");
  });

  it("transformOpenAIStream emits thinking_delta before text_delta and builds ContentBlock[]", async () => {
    async function* src(): AsyncGenerator<OpenAI.ChatCompletionChunk> {
      yield makeChunk({ reasoning_content: "Let me " });
      yield makeChunk({ reasoning_content: "think…" });
      yield makeChunk({ content: "answer: " });
      yield makeChunk({ content: "42" }, true, {
        prompt_tokens: 3,
        completion_tokens: 2,
        total_tokens: 5,
      });
    }

    const chunks: LLMStreamChunk[] = [];
    for await (const c of transformOpenAIStream(src())) {
      chunks.push(c);
    }

    const thinkings = chunks.filter(
      (c) => c.type === "thinking_delta",
    ) as Array<{
      type: "thinking_delta";
      content: string;
    }>;
    const texts = chunks.filter((c) => c.type === "text_delta") as Array<{
      type: "text_delta";
      content: string;
    }>;
    expect(thinkings.map((c) => c.content).join("")).toBe("Let me think…");
    expect(texts.map((c) => c.content).join("")).toBe("answer: 42");

    const complete = chunks.find((c) => c.type === "message_complete") as
      | { type: "message_complete"; message: ModelMessage }
      | undefined;
    expect(complete).toBeDefined();
    const blocks = complete!.message.content as ContentBlock[];
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks[0]).toEqual({ type: "thinking", thinking: "Let me think…" });
    expect(blocks[1]).toEqual({ type: "text", text: "answer: 42" });
  });

  it("transformOpenAIStream without reasoning_content keeps content as string", async () => {
    async function* src(): AsyncGenerator<OpenAI.ChatCompletionChunk> {
      yield makeChunk({ content: "plain " });
      yield makeChunk({ content: "text" }, true);
    }

    const chunks: LLMStreamChunk[] = [];
    for await (const c of transformOpenAIStream(src())) chunks.push(c);

    const complete = chunks.find((c) => c.type === "message_complete") as any;
    expect(complete.message.content).toBe("plain text");
  });

  it("attaches a trailing usage-only chunk to one message_complete event", async () => {
    async function* src(): AsyncGenerator<OpenAI.ChatCompletionChunk> {
      yield makeChunk({ content: "usage" });
      yield makeChunk({ content: " included" }, true);
      yield {
        id: "c1",
        object: "chat.completion.chunk",
        created: 0,
        model: "gpt-test",
        choices: [],
        usage: {
          prompt_tokens: 21,
          completion_tokens: 4,
          total_tokens: 25,
          prompt_tokens_details: { cached_tokens: 16 },
        },
      } as any;
    }

    const chunks: LLMStreamChunk[] = [];
    for await (const chunk of transformOpenAIStream(src())) {
      chunks.push(chunk);
    }

    const completions = chunks.filter(
      (chunk) => chunk.type === "message_complete",
    );
    expect(completions).toHaveLength(1);
    expect(completions[0]).toEqual({
      type: "message_complete",
      message: { role: "assistant", content: "usage included" },
      toolCalls: undefined,
      usage: {
        promptTokens: 21,
        completionTokens: 4,
        totalTokens: 25,
        cacheReadTokens: 16,
      },
    });
  });
});

describe("OpenAI message-adapter — user image content", () => {
  it("maps text, base64 images, and URL images in order without forwarding internal blocks", () => {
    const content: ContentBlock[] = [
      { type: "text", text: "Compare these images" },
      { type: "thinking", thinking: "internal-only" },
      {
        type: "tool_use",
        id: "tool-1",
        name: "inspect_image",
        input: {},
      },
      {
        type: "tool_result",
        toolUseId: "tool-1",
        content: "internal tool result",
      },
      {
        type: "image",
        source: {
          type: "base64",
          mediaType: "image/png",
          data: "iVBORw0KGgo=",
        },
      },
      {
        type: "image",
        source: {
          type: "url",
          url: "https://images.example.com/sample.webp",
        },
      },
      { type: "text", text: "Focus on the layout." },
    ];

    const [message] = toOpenAIMessages([{ role: "user", content }]) as any[];

    expect(message).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Compare these images" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
        },
        {
          type: "image_url",
          image_url: { url: "https://images.example.com/sample.webp" },
        },
        { type: "text", text: "Focus on the layout." },
      ],
    });
  });

  it("keeps system, assistant, and tool content text-only", () => {
    const image: ContentBlock = {
      type: "image",
      source: {
        type: "url",
        url: "https://images.example.com/not-forwarded.png",
      },
    };
    const mapped = toOpenAIMessages([
      {
        role: "system",
        content: [image, { type: "text", text: "system text" }],
      },
      {
        role: "assistant",
        content: [image, { type: "text", text: "assistant text" }],
      },
      {
        role: "tool",
        toolCallId: "tool-1",
        content: [image, { type: "text", text: "tool text" }],
      },
    ]) as any[];

    expect(mapped.map((message) => message.content)).toEqual([
      "system text",
      "assistant text",
      "tool text",
    ]);
  });

  it.each([
    {
      name: "unsupported media type",
      source: {
        type: "base64",
        mediaType: "image/svg+xml",
        data: "PHN2Zz4=",
      },
      error: "unsupported media type",
    },
    {
      name: "malformed base64",
      source: {
        type: "base64",
        mediaType: "image/jpeg",
        data: "not-base64!",
      },
      error: "invalid base64 data",
    },
    {
      name: "unsafe URL scheme",
      source: { type: "url", url: "file:///tmp/image.png" },
      error: "must use an HTTP(S) URL without credentials",
    },
  ])("rejects $name", ({ source, error }) => {
    expect(() =>
      toOpenAIMessages([
        {
          role: "user",
          content: [{ type: "image", source } as ContentBlock],
        },
      ]),
    ).toThrow(error);
  });
});
