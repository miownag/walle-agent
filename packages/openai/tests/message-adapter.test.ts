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
import type { ContentBlock, LLMStreamChunk, ModelMessage, ThinkingBlock } from "@walle-agent/core";

function makeChunk(delta: Record<string, any>, finish = false, usage?: any): OpenAI.ChatCompletionChunk {
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
    expect(blocks[0]).toEqual({ type: "thinking", thinking: "Let me think about this..." });
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

  it("toOpenAIMessages round-trips reasoning_content via assistant ThinkingBlock", () => {
    const history: ModelMessage[] = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "user said hi, reply" } satisfies ThinkingBlock,
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

    const thinkings = chunks.filter((c) => c.type === "thinking_delta") as Array<{
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
});
