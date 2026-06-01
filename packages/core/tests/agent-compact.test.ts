/**
 * Tests for `agent.compact()` and the auto macro-compression trigger.
 */

import { describe, it, expect } from "vitest";
import { Agent } from "../src/agent.js";
import { defineTool } from "../src/tool.js";
import type { LLMProvider, LLMChatRequest, LLMStreamChunk, ModelMessage } from "../src/index.js";

class ScriptedProvider implements LLMProvider {
  name = "scripted";
  public calls: LLMChatRequest[] = [];
  constructor(private steps: Array<() => AsyncIterable<LLMStreamChunk>>) {}
  async chat() {
    throw new Error("not used");
  }
  async *stream(req: LLMChatRequest) {
    this.calls.push(req);
    const step = this.steps.shift();
    if (!step) {
      yield {
        type: "message_complete" as const,
        message: { role: "assistant", content: "default" } as ModelMessage,
        toolCalls: [],
      };
      return;
    }
    yield* step();
  }
}

function fakeAssistantTurn(text: string): () => AsyncIterable<LLMStreamChunk> {
  return async function* () {
    yield { type: "text_delta", content: text };
    yield {
      type: "message_complete",
      message: { role: "assistant", content: text },
      toolCalls: [],
    };
  };
}

describe("Agent.compact() (manual)", () => {
  it("throws when a run is in flight", async () => {
    const provider = new ScriptedProvider([
      // Held forever by an unended async generator.
      async function* () {
        await new Promise((r) => setTimeout(r, 100));
        yield {
          type: "message_complete",
          message: { role: "assistant", content: "done" },
          toolCalls: [],
        };
      },
    ]);
    const agent = await Agent.create({ name: "a", model: provider });
    const runP = agent.run("hi");
    await new Promise((r) => setImmediate(r));
    await expect(agent.compact()).rejects.toThrow(/in flight/);
    await runP;
    await agent.dispose();
  });

  it("returns zero-drop result when too few messages exist", async () => {
    const agent = await Agent.create({
      name: "a",
      model: new ScriptedProvider([fakeAssistantTurn("hi")]),
    });
    const r = await agent.compact();
    expect(r.droppedMessages).toBe(0);
    await agent.dispose();
  });
});

describe("auto macro compression", () => {
  it("does NOT trigger when disabled", async () => {
    const provider = new ScriptedProvider([fakeAssistantTurn("done")]);
    const agent = await Agent.create({
      name: "a",
      model: provider,
      // macroCompression omitted → null → never triggers
    });
    await agent.run("hello");
    expect(provider.calls).toHaveLength(1);
    await agent.dispose();
  });

  it("does NOT trigger when manualOnly is true", async () => {
    const summaryCalls: LLMChatRequest[] = [];
    const summaryModel: LLMProvider = {
      name: "summary",
      async chat() {
        throw new Error("nope");
      },
      async *stream(req) {
        summaryCalls.push(req);
        yield {
          type: "message_complete",
          message: { role: "assistant", content: "summary text" } as ModelMessage,
          toolCalls: [],
        };
      },
    };
    const provider = new ScriptedProvider([fakeAssistantTurn("done")]);
    const agent = await Agent.create({
      name: "a",
      model: provider,
      macroCompression: {
        enabled: true,
        manualOnly: true,
        summaryModel,
        threshold: 0.0001, // would otherwise fire immediately
      },
    });
    await agent.run("hello");
    expect(summaryCalls).toHaveLength(0);
    await agent.dispose();
  });
});
