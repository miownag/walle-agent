import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "../src/anthropic-provider.js";

function emptyStream(): AsyncIterable<never> {
  return {
    async *[Symbol.asyncIterator]() {
      // Intentionally empty; this test only verifies SDK request options.
    },
  };
}

describe("AnthropicProvider cancellation", () => {
  it("forwards AbortSignal for chat and stream calls", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "msg-1",
      type: "message",
      role: "assistant",
      model: "test",
      content: [{ type: "text", text: "ok", citations: null }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const stream = vi.fn(() => emptyStream());
    const provider = new AnthropicProvider({ apiKey: "test-key", model: "test" });
    (provider as any).client = { messages: { create, stream } };
    const controller = new AbortController();
    const request = {
      messages: [{ role: "user" as const, content: "hello" }],
      signal: controller.signal,
    };

    await provider.chat(request);
    for await (const _chunk of provider.stream(request)) {
      // no-op
    }

    expect(create).toHaveBeenCalledWith(expect.any(Object), { signal: controller.signal });
    expect(stream).toHaveBeenCalledWith(expect.any(Object), { signal: controller.signal });
  });
});
