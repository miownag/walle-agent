import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, defineTool } from "@walle-agent/core";
import type {
  LLMProvider,
  LLMChatRequest,
  LLMChatResponse,
  LLMStreamChunk,
  ModelMessage,
  ModelToolCall,
} from "@walle-agent/core";
import { MemoryPlugin } from "../src/memory-plugin.js";

// ─── local MockProvider (same pattern as memory-plugin.integration.test.ts) ──

interface MockResponse {
  content?: string;
  toolCalls?: ModelToolCall[];
}

class MockProvider implements LLMProvider {
  name = "mock";
  callIndex = 0;
  calls: LLMChatRequest[] = [];
  constructor(public responses: MockResponse[]) {}

  async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    this.calls.push(request);
    const response = this.responses[this.callIndex++] ?? { content: "default" };
    const message: ModelMessage = {
      role: "assistant",
      content: response.content,
      toolCalls: response.toolCalls,
    };
    return { message, toolCalls: response.toolCalls };
  }

  async *stream(request: LLMChatRequest): AsyncIterable<LLMStreamChunk> {
    this.calls.push(request);
    const response = this.responses[this.callIndex++] ?? { content: "default" };
    if (response.content) yield { type: "text_delta", content: response.content };
    if (response.toolCalls) {
      for (const tc of response.toolCalls) {
        yield {
          type: "tool_call_delta",
          toolCallId: tc.id,
          name: tc.name,
          argumentsDelta: JSON.stringify(tc.arguments),
        };
      }
    }
    const message: ModelMessage = {
      role: "assistant",
      content: response.content,
      toolCalls: response.toolCalls,
    };
    yield { type: "message_complete", message, toolCalls: response.toolCalls };
  }
}

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "walle-resume-"));
}

describe("Agent.resume", () => {
  let root: string;

  beforeEach(async () => {
    root = await tmpRoot();
  });

  it("rejects an unknown sessionId", async () => {
    const plugin = new MemoryPlugin({ rootDir: root });
    await expect(
      Agent.resume("no-such-session", {
        name: "test",
        model: new MockProvider([{ content: "hi" }]),
        plugins: [plugin],
        useBuiltinTools: false,
      }),
    ).rejects.toThrow(/not found/);
  });

  it("resumes an existing session and sees its prior history on the next run", async () => {
    // Run 1 — creates the session on disk.
    const plugin1 = new MemoryPlugin({ rootDir: root });
    const mp1 = new MockProvider([{ content: "Got it" }]);
    const agent1 = await Agent.create({
      name: "test",
      model: mp1,
      plugins: [plugin1],
      useBuiltinTools: false,
    });
    const sid = agent1.sessionId;
    await agent1.run("Remember I prefer TypeScript");
    await agent1.dispose();

    // Resume.
    const plugin2 = new MemoryPlugin({ rootDir: root });
    const mp2 = new MockProvider([{ content: "TypeScript." }]);
    const agent2 = await Agent.resume(sid, {
      name: "test",
      model: mp2,
      plugins: [plugin2],
      useBuiltinTools: false,
    });
    expect(agent2.sessionId).toBe(sid);

    await agent2.run("What language do I prefer?");

    const history = mp2.calls[0].messages;
    const texts = history.filter((m) => m.role === "user").map((m) => m.content);
    expect(texts).toContain("Remember I prefer TypeScript");
    expect(texts).toContain("What language do I prefer?");

    await agent2.dispose();
  });

  it("interrupt → resume rehydrates the cancelled run's evicted tool result to full", async () => {
    const huge = "z".repeat(3000);
    const bigTool = defineTool(
      "get_log",
      "Fetch a log",
      {},
      async () => huge,
    );

    // Run 1 interrupted: the tool returns, we interrupt before the follow-up model call.
    const plugin1 = new MemoryPlugin({
      rootDir: root,
      largeToolResults: { thresholdChars: 1000 },
    });
    const cancelFromTool = defineTool(
      "get_log",
      "Fetch a log and cancel",
      {},
      async (_input, ctx) => {
        // ctx.agent is the agent running this tool call — use it to self-interrupt.
        (ctx.agent as Agent).interrupt("self-interrupt-for-test");
        return huge;
      },
    );
    const mp1 = new MockProvider([
      { toolCalls: [{ id: "tc-big", name: "get_log", arguments: {} }] },
      { content: "should-not-emit" },
    ]);
    const agent1 = await Agent.create({
      name: "test",
      model: mp1,
      plugins: [plugin1],
      tools: [cancelFromTool],
      useBuiltinTools: false,
    });
    const sid = agent1.sessionId;

    let endEvent: any;
    for await (const ev of agent1.run("go", { stream: true })) {
      if (ev.type === "run_end") endEvent = ev;
    }
    expect(endEvent.status).toBe("user-cancelled");
    await agent1.dispose();

    // Resume. The cancelled run's tool result should be rehydrated FULL.
    const plugin2 = new MemoryPlugin({
      rootDir: root,
      largeToolResults: { thresholdChars: 1000 },
    });
    const mp2 = new MockProvider([{ content: "resumed" }]);
    const agent2 = await Agent.resume(sid, {
      name: "test",
      model: mp2,
      plugins: [plugin2],
      tools: [bigTool],
      useBuiltinTools: false,
    });
    await agent2.run("continue");

    const toolMessages = mp2.calls[0].messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].content).toBe(huge);

    await agent2.dispose();
  });
});
