import { describe, expect, it, vi } from "vitest";
import { OpenAIProvider } from "../src/openai-provider.js";

function emptyStream(): AsyncIterable<never> {
  return {
    async *[Symbol.asyncIterator]() {
      // Intentionally empty; this test only verifies SDK request options.
    },
  };
}

describe("OpenAIProvider cancellation", () => {
  it("forwards AbortSignal for chat and stream calls", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        id: "chat-1",
        object: "chat.completion",
        created: 0,
        model: "test",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
      })
      .mockResolvedValueOnce(emptyStream());
    const provider = new OpenAIProvider({ apiKey: "test-key", model: "test" });
    (provider as any).client = { chat: { completions: { create } } };
    const controller = new AbortController();
    const request = {
      messages: [{ role: "user" as const, content: "hello" }],
      signal: controller.signal,
    };

    await provider.chat(request);
    for await (const _chunk of provider.stream(request)) {
      // no-op
    }

    expect(create).toHaveBeenNthCalledWith(1, expect.any(Object), { signal: controller.signal });
    expect(create).toHaveBeenNthCalledWith(2, expect.any(Object), { signal: controller.signal });
  });
});
