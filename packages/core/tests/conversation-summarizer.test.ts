/**
 * Tests for `summariseConversation` and helpers.
 */

import { describe, it, expect, vi } from "vitest";
import {
  summariseConversation,
  renderMessagesForSummary,
  DEFAULT_SUMMARY_PROMPT,
  SUMMARY_MESSAGE_PREFIX,
} from "../src/conversation-summarizer.js";
import type { LLMProvider, LLMChatRequest, LLMStreamChunk, ModelMessage } from "../src/index.js";

function makeMockProvider(
  cb: (req: LLMChatRequest) => AsyncIterable<LLMStreamChunk>,
): LLMProvider & { calls: LLMChatRequest[] } {
  const calls: LLMChatRequest[] = [];
  return {
    name: "mock-summary",
    calls,
    async chat() {
      throw new Error("not used");
    },
    async *stream(req) {
      calls.push(req);
      for await (const chunk of cb(req)) {
        yield chunk;
      }
    },
  } as LLMProvider & { calls: LLMChatRequest[] };
}

describe("renderMessagesForSummary", () => {
  it("renders simple messages", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const out = renderMessagesForSummary(msgs);
    expect(out).toContain("[USER] hi");
    expect(out).toContain("[ASSISTANT] hello");
  });

  it("renders tool messages with toolCallId markers", () => {
    const msgs: ModelMessage[] = [
      { role: "tool", toolCallId: "abc", content: "result here" },
    ];
    const out = renderMessagesForSummary(msgs);
    expect(out).toContain("toolCallId=abc");
    expect(out).toContain("result here");
  });

  it("renders assistant tool calls inline", () => {
    const msgs: ModelMessage[] = [
      {
        role: "assistant",
        content: "running tools",
        toolCalls: [{ id: "1", name: "do_thing", arguments: { x: 1 } }],
      },
    ];
    const out = renderMessagesForSummary(msgs);
    expect(out).toContain("toolCalls=do_thing");
  });

  it("truncates long content with marker", () => {
    const long = "X".repeat(800);
    const out = renderMessagesForSummary([{ role: "user", content: long }]);
    expect(out).toContain("[truncated");
  });
});

describe("summariseConversation", () => {
  it("calls model with rendered messages and returns summary text", async () => {
    const model = makeMockProvider(async function* () {
      yield { type: "text_delta", content: "- bullet 1\n- bullet 2" };
      yield {
        type: "message_complete",
        message: { role: "assistant", content: "- bullet 1\n- bullet 2" },
        toolCalls: [],
      };
    });
    const summary = await summariseConversation({
      model,
      messages: [
        { role: "user", content: "I want to refactor the auth flow." },
        { role: "assistant", content: "Sure, here are the steps..." },
      ],
    });
    expect(summary).toBe("- bullet 1\n- bullet 2");
    expect(model.calls).toHaveLength(1);
    const promptText = model.calls[0].messages[0].content as string;
    expect(promptText).toContain("Preserve");
    expect(promptText).toContain("refactor the auth flow");
  });

  it("uses message_complete content even if text_delta is empty", async () => {
    const model = makeMockProvider(async function* () {
      yield {
        type: "message_complete",
        message: { role: "assistant", content: "final-only" },
        toolCalls: [],
      };
    });
    const out = await summariseConversation({ model, messages: [{ role: "user", content: "hi" }] });
    expect(out).toBe("final-only");
  });

  it("falls back to streamed text when message_complete is missing", async () => {
    const model = makeMockProvider(async function* () {
      yield { type: "text_delta", content: "partial " };
      yield { type: "text_delta", content: "stream" };
    });
    const out = await summariseConversation({ model, messages: [{ role: "user", content: "x" }] });
    expect(out).toBe("partial stream");
  });

  it("rejects template without {{messages}}", async () => {
    const model = makeMockProvider(async function* () {});
    await expect(
      summariseConversation({
        model,
        messages: [],
        promptTemplate: "no placeholder",
      }),
    ).rejects.toThrow(/\{\{messages\}\}/);
  });

  it("throws on stream error chunk", async () => {
    const model = makeMockProvider(async function* () {
      yield { type: "error", error: new Error("boom") };
    });
    await expect(
      summariseConversation({ model, messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow("boom");
  });
});

describe("constants", () => {
  it("SUMMARY_MESSAGE_PREFIX is stable", () => {
    expect(SUMMARY_MESSAGE_PREFIX).toBe("[Summary of ");
  });
  it("DEFAULT_SUMMARY_PROMPT contains the placeholder", () => {
    expect(DEFAULT_SUMMARY_PROMPT).toContain("{{messages}}");
  });
});
