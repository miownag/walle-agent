import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@walle-agent/core";
import type {
  LLMProvider,
  LLMChatRequest,
  LLMChatResponse,
  LLMStreamChunk,
  ModelMessage,
  ModelToolCall,
} from "@walle-agent/core";
import { MemoryPlugin } from "@walle-agent/memory";
import { SkillsPlugin } from "@walle-agent/skills";
import { EvolutionPlugin } from "../src/evolution-plugin.js";

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "walle-evol-int-"));
}

interface MockResp {
  content?: string;
  toolCalls?: ModelToolCall[];
  /** If true, classifies this response as an evolution-extraction reply. */
  forEvolution?: boolean;
}

/**
 * MockProvider that splits traffic:
 *  - `stream(...)` calls go to the normal `runResponses` queue.
 *  - `chat(...)` calls (used by evolution extraction) go to the `evolResponses` queue.
 */
class MockProvider implements LLMProvider {
  name = "mock-evol-int";
  streamCalls: LLMChatRequest[] = [];
  chatCalls: LLMChatRequest[] = [];

  constructor(
    public runResponses: MockResp[],
    public evolResponses: string[] = [],
  ) {}

  async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    this.chatCalls.push(request);
    const text = this.evolResponses.shift() ?? "{}";
    return { message: { role: "assistant", content: text } };
  }

  async *stream(request: LLMChatRequest): AsyncIterable<LLMStreamChunk> {
    this.streamCalls.push(request);
    const r = this.runResponses.shift() ?? { content: "ok" };
    if (r.content) yield { type: "text_delta", content: r.content };
    if (r.toolCalls) {
      for (const tc of r.toolCalls) {
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
      content: r.content,
      toolCalls: r.toolCalls,
    };
    yield { type: "message_complete", message, toolCalls: r.toolCalls };
  }
}

async function waitForCondition(check: () => boolean | Promise<boolean>, ms = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const ok = await check();
    if (ok) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("EvolutionPlugin — integration", () => {
  let root: string;

  beforeEach(async () => {
    root = await tmpRoot();
  });

  it("explicit remember → memory auto-applied (requireApproval=false by default)", async () => {
    const mp = new MockProvider(
      [{ content: "Got it." }],
      [
        JSON.stringify({
          memories: [
            {
              type: "preference",
              content: "User prefers pnpm",
              importance: 0.8,
              confidence: 0.9,
              scope: "long",
              tags: ["package-manager"],
            },
          ],
        }),
      ],
    );

    const memoryPlugin = new MemoryPlugin({ rootDir: root });
    const evolutionPlugin = new EvolutionPlugin({
      rootDir: path.join(root, "evolution"),
      explicitRemember: { enabled: true },
      memoryCreation: { enabled: true, minImportance: 0.3, minConfidence: 0.3 },
    });

    const agent = await Agent.create({
      name: "test",
      model: mp,
      plugins: [memoryPlugin, evolutionPlugin],
      useBuiltinTools: false,
    });

    await agent.run("Please remember that I prefer pnpm", { sessionId: "s1" });
    // Evolution runs in the background after run_end; wait for the chat call.
    await waitForCondition(() => mp.chatCalls.length > 0);
    // Give the extraction + memory write a beat to finish.
    await waitForCondition(async () => (await memoryPlugin.manager.list()).length > 0, 2000);

    const stored = await memoryPlugin.manager.list();
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toContain("pnpm");

    await agent.dispose();
  });

  it("periodic review fires every N runs and proposes memories", async () => {
    // Arrange: 3 runs; periodic review fires on turn 3 only.
    const mp = new MockProvider(
      [
        { content: "a1" },
        { content: "a2" },
        { content: "a3" },
      ],
      [
        JSON.stringify({
          memories: [
            {
              type: "summary",
              content: "session summary snippet",
              importance: 0.7,
              confidence: 0.9,
              scope: "mid",
            },
          ],
        }),
      ],
    );

    const memoryPlugin = new MemoryPlugin({ rootDir: root });
    const evolutionPlugin = new EvolutionPlugin({
      rootDir: path.join(root, "evolution"),
      explicitRemember: { enabled: false },
      periodicReview: { enabled: true, everyTurns: 3 },
      memoryCreation: { enabled: true, minImportance: 0.3, minConfidence: 0.3 },
    });

    const agent = await Agent.create({
      name: "test",
      model: mp,
      plugins: [memoryPlugin, evolutionPlugin],
      useBuiltinTools: false,
    });

    await agent.run("u1", { sessionId: "s1" });
    await agent.run("u2", { sessionId: "s1" });
    expect(mp.chatCalls.length).toBe(0); // No review yet.

    await agent.run("u3", { sessionId: "s1" });
    await waitForCondition(() => mp.chatCalls.length > 0);
    await waitForCondition(
      async () => (await memoryPlugin.manager.list()).length > 0,
      2000,
    );

    const stored = await memoryPlugin.manager.list();
    expect(stored.some((s) => s.content.includes("session summary"))).toBe(true);

    await agent.dispose();
  });

  it("task review proposes a skill when enough tool calls occur", async () => {
    const mp = new MockProvider(
      [
        { toolCalls: [{ id: "t1", name: "t", arguments: {} }] },
        { toolCalls: [{ id: "t2", name: "t", arguments: {} }] },
        { toolCalls: [{ id: "t3", name: "t", arguments: {} }] },
        { content: "done" },
      ],
      [
        JSON.stringify({
          skill: {
            name: "reusable_flow",
            description: "A reusable procedure distilled from the conversation",
            content: "1. step one\n2. step two",
            tags: ["flow"],
            confidence: 0.85,
            triggerExamples: ["run the flow"],
          },
        }),
      ],
    );

    const { defineTool } = await import("@walle-agent/core");
    const tTool = defineTool(
      "t",
      "no-op",
      {},
      async () => "ok",
    );

    const memoryPlugin = new MemoryPlugin({ rootDir: root });
    const skillsPlugin = new SkillsPlugin({ project: path.join(root, "agents-project"), user: path.join(root, "agents-user") });
    const evolutionPlugin = new EvolutionPlugin({
      rootDir: path.join(root, "evolution"),
      explicitRemember: { enabled: false },
      periodicReview: { enabled: false },
      taskReview: { enabled: true, minToolCalls: 2 },
      skillCreation: { enabled: true, requireApproval: false, minConfidence: 0.5 },
    });

    const agent = await Agent.create({
      name: "test",
      model: mp,
      plugins: [memoryPlugin, skillsPlugin, evolutionPlugin],
      tools: [tTool],
      useBuiltinTools: false,
    });

    await agent.run("do the flow", { sessionId: "s1" });
    await waitForCondition(() => mp.chatCalls.length > 0, 2000);
    await waitForCondition(() => skillsPlugin.registry.list().length > 0, 2000);

    const skills = skillsPlugin.registry.list();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("reusable_flow");
    expect(skills[0].metadata.createdBy).toBe("agent");

    await agent.dispose();
  });

  it("fails fast when MemoryPlugin is not installed", async () => {
    const mp = new MockProvider([{ content: "x" }]);
    const evolutionPlugin = new EvolutionPlugin({ rootDir: path.join(root, "evolution") });

    await expect(
      Agent.create({
        name: "test",
        model: mp,
        plugins: [evolutionPlugin],
        useBuiltinTools: false,
      }),
    ).rejects.toThrow(/MemoryPlugin/);
  });

  it("approveAndApply writes a previously queued memory into long-term memory", async () => {
    const mp = new MockProvider(
      [{ content: "hi" }],
      [
        JSON.stringify({
          memories: [
            {
              type: "fact",
              content: "queued fact",
              importance: 0.9,
              confidence: 0.9,
              scope: "long",
            },
          ],
        }),
      ],
    );

    const memoryPlugin = new MemoryPlugin({ rootDir: root });
    const evolutionPlugin = new EvolutionPlugin({
      rootDir: path.join(root, "evolution"),
      explicitRemember: { enabled: true },
      // Require approval so the memory is queued.
      memoryCreation: { enabled: true, requireApproval: true, minImportance: 0.3, minConfidence: 0.3 },
    });

    const agent = await Agent.create({
      name: "test",
      model: mp,
      plugins: [memoryPlugin, evolutionPlugin],
      useBuiltinTools: false,
    });

    await agent.run("remember this", { sessionId: "s1" });
    await waitForCondition(async () => (await evolutionPlugin.pending()).length > 0, 2000);

    const pending = await evolutionPlugin.pending();
    expect(pending).toHaveLength(1);
    expect(await memoryPlugin.manager.list()).toHaveLength(0);

    await evolutionPlugin.approveAndApply(pending[0].id!, "looks good");

    const stored = await memoryPlugin.manager.list();
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toBe("queued fact");

    // Proposal status should be `applied`.
    const finalState = await evolutionPlugin.proposalStore.get(pending[0].id!);
    expect(finalState?.status).toBe("applied");

    await agent.dispose();
  });
});
