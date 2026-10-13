import { expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import type {
  LLMProvider,
  LLMChatRequest,
  LLMStreamChunk,
  ModelMessage,
} from "../src/index.js";

it("injects guidance after paired tool results and before the next model request", async () => {
  const calls: ModelMessage[][] = [];
  let agent: Agent;
  const model: LLMProvider = {
    name: "steering-test",
    chat: async () => {
      throw new Error("stream only");
    },
    async *stream(request: LLMChatRequest): AsyncIterable<LLMStreamChunk> {
      calls.push(structuredClone(request.messages));
      if (calls.length === 1) {
        expect(agent.steer("Use the new direction")).toBe(true);
        yield {
          type: "message_complete",
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call-1", name: "probe", arguments: {} }],
          },
          toolCalls: [{ id: "call-1", name: "probe", arguments: {} }],
        };
      } else
        yield {
          type: "message_complete",
          message: { role: "assistant", content: "done" },
        };
    },
  };
  agent = await Agent.create({
    name: "test",
    model,
    useBuiltinTools: false,
    tools: [
      {
        name: "probe",
        description: "Probe",
        inputSchema: { type: "object", properties: {} },
        execute: async () => "result",
      },
    ],
  });
  expect(agent.steer("idle")).toBe(false);
  try {
    const result = await agent.run("Original task");
    expect(
      result.events.filter((event) => event.type === "input_steered"),
    ).toHaveLength(1);
    expect(calls[1].map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "user",
    ]);
    expect(calls[1].at(-1)?.content).toBe("Use the new direction");
    expect(calls[1][2].toolCallId).toBe("call-1");
  } finally {
    await agent.dispose();
  }
});

it("continues after a final response when guidance arrived during that response", async () => {
  let agent: Agent;
  let calls = 0;
  const model: LLMProvider = {
    name: "test",
    chat: async () => {
      throw new Error("stream only");
    },
    async *stream(): AsyncIterable<LLMStreamChunk> {
      if (++calls === 1) agent.steer("Additional requirement");
      yield {
        type: "message_complete",
        message: {
          role: "assistant",
          content: calls === 1 ? "first" : "updated",
        },
      };
    },
  };
  agent = await Agent.create({ name: "test", model, useBuiltinTools: false });
  try {
    expect((await agent.run("Task")).messages.at(-1)?.content).toBe("updated");
    expect(calls).toBe(2);
  } finally {
    await agent.dispose();
  }
});
