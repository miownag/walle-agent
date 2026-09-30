/**
 * Tests for `agent.compact()` and the auto macro-compression trigger.
 */

import { describe, it, expect } from "vitest";
import { Agent } from "../src/agent.js";
import type {
  AgentEventMap,
  LLMProvider,
  LLMChatRequest,
  LLMStreamChunk,
  ModelMessage,
  WallePlugin,
} from "../src/index.js";

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

  it("emits the complete post-compaction snapshot after summarization succeeds", async () => {
    const history: ModelMessage[] = [
      { role: "user", content: "old user 1" },
      { role: "assistant", content: "old assistant 1" },
      { role: "user", content: "old user 2" },
      { role: "assistant", content: "old assistant 2" },
      { role: "user", content: "recent user" },
      { role: "assistant", content: "recent assistant" },
    ];
    let completed: AgentEventMap["compaction_done"] | undefined;
    const historyPlugin: WallePlugin = {
      name: "compact-history",
      install(ctx) {
        ctx.events.on("collect_messages", ({ into }) => {
          into.push(...history);
        });
        ctx.events.on("compaction_done", (payload) => {
          completed = payload;
        });
      },
    };
    const summaryModel = new ScriptedProvider([
      fakeAssistantTurn("durable summary"),
    ]);
    const agent = await Agent.create({
      name: "a",
      model: new ScriptedProvider([]),
      plugins: [historyPlugin],
    });

    const result = await agent.compact({
      keepRecentTurns: 1,
      summaryModel,
    });

    expect(result.droppedMessages).toBeGreaterThan(0);
    expect(completed?.messages.map((message) => message.content)).toEqual([
      "[Summary of 5 earlier messages]\ndurable summary",
      "recent assistant",
    ]);
    expect(completed?.after).toBe(2);
    await agent.dispose();
  });

  it("does not emit compaction_done when summarization fails", async () => {
    let completed = false;
    const historyPlugin: WallePlugin = {
      name: "compact-history",
      install(ctx) {
        ctx.events.on("collect_messages", ({ into }) => {
          into.push(
            { role: "user", content: "old user" },
            { role: "assistant", content: "old assistant" },
            { role: "assistant", content: "recent assistant" },
          );
        });
        ctx.events.on("compaction_done", () => {
          completed = true;
        });
      },
    };
    const failingSummaryModel: LLMProvider = {
      name: "failing-summary",
      async chat() {
        throw new Error("not used");
      },
      async *stream() {
        yield { type: "error", error: new Error("summary failed") };
      },
    };
    const agent = await Agent.create({
      name: "a",
      model: new ScriptedProvider([]),
      plugins: [historyPlugin],
    });

    await expect(
      agent.compact({ keepRecentTurns: 1, summaryModel: failingSummaryModel }),
    ).rejects.toThrow("summary failed");
    expect(completed).toBe(false);
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
          message: {
            role: "assistant",
            content: "summary text",
          } as ModelMessage,
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
