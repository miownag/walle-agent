/**
 * Anthropic message-adapter tests — focus on ThinkingBlock multi-turn preservation.
 */

import { describe, it, expect } from "vitest";
import { toAnthropicMessages, fromAnthropicResponse } from "../src/message-adapter.js";
import type { ModelMessage, ThinkingBlock, ContentBlock } from "@walle-agent/core";

describe("Anthropic message-adapter — ThinkingBlock round-trip", () => {
  it("toAnthropicMessages preserves signed thinking block before text", () => {
    const history: ModelMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "user greeted", signature: "sig-abc" } satisfies ThinkingBlock,
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
          { type: "thinking", thinking: "no signature" } satisfies ThinkingBlock,
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
          { type: "thinking", thinking: "", data: "opaque-blob" } satisfies ThinkingBlock,
          { type: "text", text: "answer" },
        ],
      },
    ];

    const { messages } = toAnthropicMessages(history);
    const assistant = messages[0] as any;
    expect(assistant.content[0]).toEqual({ type: "redacted_thinking", data: "opaque-blob" });
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
});
