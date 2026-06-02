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
import { tryDecodeEviction } from "../src/tool-result-vault.js";

// ─── Scripted MockProvider (local copy to avoid cross-package test imports) ───

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

    if (response.content) {
      yield { type: "text_delta", content: response.content };
    }
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
  return fs.mkdtemp(path.join(os.tmpdir(), "walle-memory-int-"));
}

describe("MemoryPlugin integration", () => {
  let root: string;

  beforeEach(async () => {
    root = await tmpRoot();
  });

  it("A — session round-trip: second run sees prior history", async () => {
    const plugin = new MemoryPlugin({ rootDir: root });

    const mp1 = new MockProvider([{ content: "Got it, I'll remember." }]);
    const agent1 = await Agent.create({
      name: "test",
      model: mp1,
      plugins: [plugin],
      useBuiltinTools: false,
    });
    await agent1.run("Remember that I prefer TypeScript", { sessionId: "s1" });
    await agent1.dispose();

    const plugin2 = new MemoryPlugin({ rootDir: root });
    const mp2 = new MockProvider([{ content: "You prefer TypeScript." }]);
    const agent2 = await Agent.create({
      name: "test",
      model: mp2,
      plugins: [plugin2],
      useBuiltinTools: false,
    });
    await agent2.run("What language do I prefer?", { sessionId: "s1" });

    // The LLM request should have seen prior messages.
    const history = mp2.calls[0].messages;
    const userTexts = history.filter((m) => m.role === "user").map((m) => m.content);
    expect(userTexts).toContain("Remember that I prefer TypeScript");
    expect(userTexts).toContain("What language do I prefer?");

    const assistantTexts = history.filter((m) => m.role === "assistant").map((m) => m.content);
    expect(assistantTexts).toContain("Got it, I'll remember.");

    await agent2.dispose();
  });

  it("B — oversized tool result is evicted; next run sees a summary", async () => {
    const huge = "x".repeat(5000);
    const bigTool = defineTool(
      "get_log",
      "Fetch a log",
      {},
      async () => huge,
    );

    const mp1 = new MockProvider([
      { toolCalls: [{ id: "tc-1", name: "get_log", arguments: {} }] },
      { content: "I fetched the log." },
    ]);
    const plugin = new MemoryPlugin({
      rootDir: root,
      largeToolResults: { thresholdChars: 1000 },
    });
    const agent = await Agent.create({
      name: "test",
      model: mp1,
      plugins: [plugin],
      tools: [bigTool],
      useBuiltinTools: false,
    });
    await agent.run("fetch the log", { sessionId: "s1" });
    await agent.dispose();

    // On disk, messages.jsonl should contain an evicted-stub envelope.
    const msgFile = path.join(root, "sessions", "s1", "messages.jsonl");
    const lines = (await fs.readFile(msgFile, "utf-8")).trim().split("\n");
    const toolLine = lines
      .map((l) => JSON.parse(l))
      .find((r) => r.message.role === "tool");
    expect(toolLine).toBeTruthy();
    const envelope = tryDecodeEviction(toolLine.message.content);
    expect(envelope).toBeTruthy();
    expect(envelope!.size).toBe(5000);
    expect(envelope!.path.endsWith("tc-1.txt")).toBe(true);

    // The dumped .txt contains the full payload.
    const txt = await fs.readFile(envelope!.path, "utf-8");
    expect(txt).toBe(huge);

    // Run #2 with same sessionId: tool message should be the summary string.
    const plugin2 = new MemoryPlugin({
      rootDir: root,
      largeToolResults: { thresholdChars: 1000 },
    });
    const mp2 = new MockProvider([{ content: "OK." }]);
    const agent2 = await Agent.create({
      name: "test",
      model: mp2,
      plugins: [plugin2],
      useBuiltinTools: false,
    });
    await agent2.run("anything else?", { sessionId: "s1" });

    const req2 = mp2.calls[0];
    const toolMessages = req2.messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(1);
    const content = toolMessages[0].content as string;
    expect(content.startsWith("Tool result too long.")).toBe(true);
    expect(content).toContain(envelope!.path);

    await agent2.dispose();
  });

  it("C — cancel-and-resume: the cancelled run's tool result is rehydrated to full", async () => {
    const huge = "y".repeat(4000);
    const bigTool = defineTool(
      "get_log",
      "Fetch a log",
      {},
      async () => huge,
    );

    // Run #1 completes (for baseline comparison)
    const plugin1 = new MemoryPlugin({
      rootDir: root,
      largeToolResults: { thresholdChars: 1000 },
    });
    const mpA = new MockProvider([
      { toolCalls: [{ id: "tc-A", name: "get_log", arguments: {} }] },
      { content: "A done" },
    ]);
    const agentA = await Agent.create({
      name: "test",
      model: mpA,
      plugins: [plugin1],
      tools: [bigTool],
      useBuiltinTools: false,
    });
    await agentA.run("A", { sessionId: "s1" });
    await agentA.dispose();

    // Run #2 cancels right after the tool call, before the next model call.
    const plugin2 = new MemoryPlugin({
      rootDir: root,
      largeToolResults: { thresholdChars: 1000 },
    });
    // Use a tool whose execution triggers abort, so the generator sees it
    // between tool-call-end and the next model-call-start check.
    const controller = new AbortController();
    const cancellingTool = defineTool(
      "get_log",
      "Fetch a log (also cancels)",
      {},
      async () => {
        controller.abort();
        return huge;
      },
    );
    const mpB = new MockProvider([
      { toolCalls: [{ id: "tc-B", name: "get_log", arguments: {} }] },
      { content: "should-never-emit" },
    ]);
    const agentB = await Agent.create({
      name: "test",
      model: mpB,
      plugins: [plugin2],
      tools: [cancellingTool],
      useBuiltinTools: false,
    });
    const streamB = agentB.run("B", { stream: true, sessionId: "s1", signal: controller.signal });
    let endEvent: any;
    for await (const ev of streamB) {
      if (ev.type === "run_end") endEvent = ev;
    }
    expect(endEvent.status).toBe("user-cancelled");
    await agentB.dispose();

    // Run #3 same session. The cancelled run's tool result should rehydrate to
    // FULL content; the earlier completed run should still be summarized.
    const plugin3 = new MemoryPlugin({
      rootDir: root,
      largeToolResults: { thresholdChars: 1000 },
    });
    const mpC = new MockProvider([{ content: "C done" }]);
    const agentC = await Agent.create({
      name: "test",
      model: mpC,
      plugins: [plugin3],
      useBuiltinTools: false,
    });
    await agentC.run("C", { sessionId: "s1" });

    const historyC = mpC.calls[0].messages.filter((m) => m.role === "tool");
    expect(historyC).toHaveLength(2);

    // Determine which is which by toolCallId (embedded or on the message).
    const byId = new Map<string, string>();
    for (const m of historyC) byId.set(m.toolCallId ?? "", m.content as string);

    const fullForB = byId.get("tc-B");
    const summaryForA = byId.get("tc-A");
    expect(fullForB).toBe(huge); // rehydrated
    expect(summaryForA?.startsWith("Tool result too long.")).toBe(true); // summarized

    await agentC.dispose();
  });

  it("D — LTM retrieval: remember tool writes, collect_context surfaces on next run", async () => {
    const plugin = new MemoryPlugin({ rootDir: root });

    const mp1 = new MockProvider([
      {
        toolCalls: [
          {
            id: "tc-rem",
            name: "remember",
            arguments: {
              content: "User prefers pnpm over npm",
              tags: ["package-manager"],
              type: "preference",
            },
          },
        ],
      },
      { content: "Saved." },
    ]);
    const agent = await Agent.create({
      name: "test",
      model: mp1,
      plugins: [plugin],
      useBuiltinTools: false,
    });
    await agent.run("Remember: I prefer pnpm over npm", { sessionId: "s1" });
    await agent.dispose();

    // New plugin instance — ensures persistence
    const plugin2 = new MemoryPlugin({ rootDir: root });
    const mp2 = new MockProvider([{ content: "pnpm, per your preference." }]);
    const agent2 = await Agent.create({
      name: "test",
      model: mp2,
      plugins: [plugin2],
      useBuiltinTools: false,
    });
    await agent2.run("Which package manager should I use?", { sessionId: "s1" });

    const req = mp2.calls[0];
    const systemMsg = req.messages.find((m) => m.role === "system");
    expect(systemMsg).toBeTruthy();
    const systemContent = systemMsg!.content as string;
    expect(systemContent).toContain("User prefers pnpm over npm");

    await agent2.dispose();
  });

  it("E — dedup: two near-identical remember calls end up as one memory", async () => {
    const plugin = new MemoryPlugin({ rootDir: root, longTerm: { dedupThreshold: 0.5 } });

    const mp = new MockProvider([
      {
        toolCalls: [
          {
            id: "t1",
            name: "remember",
            arguments: { content: "user prefers typescript", type: "preference" },
          },
        ],
      },
      {
        toolCalls: [
          {
            id: "t2",
            name: "remember",
            arguments: {
              content: "user prefers typescript strongly",
              type: "preference",
              importance: 0.9,
            },
          },
        ],
      },
      { content: "done" },
    ]);
    const agent = await Agent.create({
      name: "test",
      model: mp,
      plugins: [plugin],
      useBuiltinTools: false,
    });
    await agent.run("remember my preference twice", { sessionId: "s1" });

    const items = await plugin.manager.list();
    expect(items).toHaveLength(1);
    expect(items[0].importance).toBeCloseTo(0.9);
    expect(items[0].updatedAt).toBeTruthy();

    await agent.dispose();
  });

  it("F — auto-assigned sessionId writes under agent.sessionId", async () => {
    const plugin = new MemoryPlugin({ rootDir: root });
    const mp = new MockProvider([{ content: "hi" }]);
    const agent = await Agent.create({
      name: "test",
      model: mp,
      plugins: [plugin],
      useBuiltinTools: false,
    });

    expect(agent.sessionId).toBeTruthy();
    await agent.run("hello");
    await agent.dispose();

    // The auto-assigned sessionId should have a directory on disk.
    const sessionEntries = await fs.readdir(path.join(root, "sessions"));
    expect(sessionEntries).toEqual([agent.sessionId]);
  });
});
