import { describe, it, expect } from "vitest";
import { AgentStream } from "../src/stream.js";
import type { AgentStreamEvent } from "../src/stream.js";

function createMockGenerator(events: AgentStreamEvent[]): AsyncGenerator<AgentStreamEvent> {
  return (async function* () {
    for (const event of events) {
      yield event;
    }
  })();
}

describe("AgentStream", () => {
  it("should collect text content", async () => {
    const events: AgentStreamEvent[] = [
      { type: "run_start", input: { content: "test" }, runId: "r1" },
      { type: "model_call_start", turn: 0 },
      { type: "text_delta", content: "Hello" },
      { type: "text_delta", content: " World" },
      {
        type: "model_call_end",
        message: { role: "assistant", content: "Hello World" },
      },
      { type: "run_end", runId: "r1", status: "completed" },
    ];

    const stream = new AgentStream(createMockGenerator(events));
    const result = await stream.collect();

    expect(result.content).toBe("Hello World");
    expect(result.events).toHaveLength(6);
    expect(result.messages).toHaveLength(1);
  });

  it("should yield only text via text() helper", async () => {
    const events: AgentStreamEvent[] = [
      { type: "run_start", input: { content: "test" }, runId: "r1" },
      { type: "text_delta", content: "A" },
      { type: "text_delta", content: "B" },
      { type: "run_end", runId: "r1", status: "completed" },
    ];

    const stream = new AgentStream(createMockGenerator(events));
    const texts: string[] = [];

    for await (const text of stream.text()) {
      texts.push(text);
    }

    expect(texts).toEqual(["A", "B"]);
  });

  it("should collect tool call records", async () => {
    const events: AgentStreamEvent[] = [
      { type: "run_start", input: { content: "test" }, runId: "r1" },
      {
        type: "tool_call_end",
        record: {
          id: "tc1",
          name: "test_tool",
          input: { foo: "bar" },
          output: { result: "ok" },
          status: "success",
        },
      },
      { type: "run_end", runId: "r1", status: "completed" },
    ];

    const stream = new AgentStream(createMockGenerator(events));
    const result = await stream.collect();

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("test_tool");
  });

  it("should support pipe transform", async () => {
    const events: AgentStreamEvent[] = [
      { type: "text_delta", content: "hello" },
      { type: "run_end", runId: "r1", status: "completed" },
    ];

    const stream = new AgentStream(createMockGenerator(events));
    const upper = stream.pipe((event) => {
      if (event.type === "text_delta") return event.content.toUpperCase();
      return null;
    });

    const results: string[] = [];
    for await (const item of upper) {
      results.push(item);
    }

    expect(results).toEqual(["HELLO"]);
  });
});
