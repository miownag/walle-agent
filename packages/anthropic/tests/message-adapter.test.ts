/**
 * Anthropic message-adapter tests — focus on ThinkingBlock multi-turn preservation.
 */

import { describe, it, expect } from "vitest";
import {
  toAnthropicMessages,
  fromAnthropicResponse,
  transformAnthropicStream,
} from "../src/message-adapter.js";
import type {
  ModelMessage,
  ThinkingBlock,
  ContentBlock,
  LLMStreamChunk,
} from "@walle-agent/core";

describe("Anthropic message-adapter — ThinkingBlock round-trip", () => {
  it("toAnthropicMessages preserves signed thinking block before text", () => {
    const history: ModelMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "user greeted",
            signature: "sig-abc",
          } satisfies ThinkingBlock,
          { type: "text", text: "hello there" },
        ],
      },
    ];

    const { messages } = toAnthropicMessages(history);
    const assistant = messages[1] as any;
    expect(assistant.role).toBe("assistant");
    expect(Array.isArray(assistant.content)).toBe(true);
    expect(assistant.content[0]).toEqual({
      type: "thinking",
      thinking: "user greeted",
      signature: "sig-abc",
    });
    expect(assistant.content[1]).toEqual({ type: "text", text: "hello there" });
  });

  it("toAnthropicMessages drops unsigned thinking (Anthropic rejects it on resume)", () => {
    const history: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "no signature",
          } satisfies ThinkingBlock,
          { type: "text", text: "visible" },
        ],
      },
    ];

    const { messages } = toAnthropicMessages(history);
    const assistant = messages[0] as any;
    expect(Array.isArray(assistant.content)).toBe(true);
    // no thinking block preserved, only text
    expect(assistant.content).toHaveLength(1);
    expect(assistant.content[0]).toEqual({ type: "text", text: "visible" });
  });

  it("toAnthropicMessages preserves redacted_thinking via data field", () => {
    const history: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "",
            data: "opaque-blob",
          } satisfies ThinkingBlock,
          { type: "text", text: "answer" },
        ],
      },
    ];

    const { messages } = toAnthropicMessages(history);
    const assistant = messages[0] as any;
    expect(assistant.content[0]).toEqual({
      type: "redacted_thinking",
      data: "opaque-blob",
    });
  });

  it("fromAnthropicResponse stores thinking signature on ThinkingBlock", () => {
    const resp = {
      id: "m1",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "deep thought", signature: "sig-xyz" },
        { type: "text", text: "the answer" },
      ],
      usage: { input_tokens: 5, output_tokens: 3 },
    } as any;

    const result = fromAnthropicResponse(resp);
    const blocks = result.message.content as ContentBlock[];
    expect(Array.isArray(blocks)).toBe(true);
    const thinking = blocks.find((b) => b.type === "thinking") as ThinkingBlock;
    expect(thinking.thinking).toBe("deep thought");
    expect(thinking.signature).toBe("sig-xyz");
  });

  it("includes cache reads and writes in non-streaming input usage", () => {
    const response = {
      content: [{ type: "text", text: "done" }],
      usage: {
        input_tokens: 20,
        output_tokens: 5,
        cache_read_input_tokens: 60,
        cache_creation_input_tokens: 10,
      },
    } as any;
    expect(fromAnthropicResponse(response).usage).toMatchObject({
      promptTokens: 90,
      completionTokens: 5,
      totalTokens: 95,
      cacheReadTokens: 60,
      cacheWriteTokens: 10,
    });
  });

  it("merges streaming output usage without losing input or cache tokens", async () => {
    async function* src(): AsyncGenerator<any> {
      yield {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 120,
            output_tokens: 1,
            cache_read_input_tokens: 80,
            cache_creation_input_tokens: 12,
          },
        },
      };
      yield {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "done" },
      };
      yield {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 9 },
      };
      yield { type: "message_stop" };
    }

    const chunks: LLMStreamChunk[] = [];
    for await (const chunk of transformAnthropicStream(src())) {
      chunks.push(chunk);
    }

    const completion = chunks.find(
      (chunk) => chunk.type === "message_complete",
    );
    expect(completion).toMatchObject({
      type: "message_complete",
      usage: {
        promptTokens: 212,
        completionTokens: 9,
        totalTokens: 221,
        cacheReadTokens: 80,
        cacheWriteTokens: 12,
      },
    });
  });
});

describe("Anthropic message-adapter — user image content", () => {
  it("maps text, base64 images, and SDK-supported URL images without forwarding internal blocks", () => {
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

    const { messages } = toAnthropicMessages([{ role: "user", content }]);

    expect(messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Compare these images" },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
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
    const { system, messages } = toAnthropicMessages([
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
    ]);

    expect(system).toBe("system text");
    expect((messages[0] as any).content).toEqual([
      { type: "text", text: "assistant text" },
    ]);
    expect((messages[1] as any).content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "tool-1",
        content: "tool text",
      },
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
      source: { type: "url", url: "data:image/png;base64,iVBORw0KGgo=" },
      error: "must use an HTTP(S) URL without credentials",
    },
  ])("rejects $name", ({ source, error }) => {
    expect(() =>
      toAnthropicMessages([
        {
          role: "user",
          content: [{ type: "image", source } as ContentBlock],
        },
      ]),
    ).toThrow(error);
  });
});
