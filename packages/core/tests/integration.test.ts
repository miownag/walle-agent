import { describe, it, expect } from "vitest";
import { Agent } from "../src/agent.js";
import { defineTool } from "../src/tool.js";
import type { AgentStreamEvent } from "../src/stream.js";
import type { WallePlugin } from "../src/plugin.js";
import type { AgentContext } from "../src/agent-context.js";
import { MockProvider } from "./mock-provider.js";

describe("Agent Integration", () => {
  it("should run non-streaming and return content", async () => {
    const provider = new MockProvider([{ content: "Hello! How can I help?" }]);

    const agent = await Agent.create({
      name: "test-agent",
      model: provider,
    });

    const result = await agent.run("hi");

    expect(result.content).toBe("Hello! How can I help?");
    expect(result.messages).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);
    // Messages sent to LLM: at minimum a user message
    const sentMessages = provider.calls[0].messages;
    const userMsg = sentMessages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toBe("hi");

    await agent.dispose();
  });

  it("should run streaming and yield events", async () => {
    const provider = new MockProvider([{ content: "streaming response" }]);

    const agent = await Agent.create({
      name: "test-agent",
      model: provider,
    });

    const events: AgentStreamEvent[] = [];
    const stream = agent.run("hello", { stream: true });

    for await (const event of stream) {
      events.push(event);
    }

    expect(events.some((e) => e.type === "run_start")).toBe(true);
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.some((e) => e.type === "model_call_end")).toBe(true);
    expect(events.some((e) => e.type === "run_end")).toBe(true);

    // Collect text deltas
    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as { type: "text_delta"; content: string }).content)
      .join("");
    expect(text).toBe("streaming response");

    await agent.dispose();
  });

  it("should execute tool calls and loop back", async () => {
    const provider = new MockProvider([
      // First response: call a tool
      {
        toolCalls: [
          { id: "tc1", name: "calculator", arguments: { expression: "2+2" } },
        ],
      },
      // Second response: final text
      { content: "The answer is 4." },
    ]);

    const calculator = defineTool({
      name: "calculator",
      description: "Calculate math expressions",
      parameters: {
        type: "object",
        properties: { expression: { type: "string" } },
        required: ["expression"],
      },
      async execute(input: { expression: string }) {
        // Simple eval for test
        return { result: eval(input.expression) };
      },
    });

    const agent = await Agent.create({
      name: "test-agent",
      model: provider,
      tools: [calculator],
    });

    const result = await agent.run("what is 2+2?");

    expect(result.content).toBe("The answer is 4.");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("calculator");
    expect(result.toolCalls[0].status).toBe("success");
    expect(provider.calls).toHaveLength(2);

    await agent.dispose();
  });

  it("should use system prompt", async () => {
    const provider = new MockProvider([{ content: "I am helpful" }]);

    const agent = await Agent.create({
      name: "test-agent",
      model: provider,
      systemPrompt: "You are a helpful assistant.",
    });

    await agent.run("hello");

    expect(provider.calls[0].messages[0].role).toBe("system");
    expect(provider.calls[0].messages[0].content).toContain("You are a helpful assistant.");

    await agent.dispose();
  });

  it("should install plugins", async () => {
    const provider = new MockProvider([{ content: "ok" }]);
    let pluginInstalled = false;
    let pluginDisposed = false;

    const testPlugin: WallePlugin = {
      name: "test-plugin",
      install(_ctx: AgentContext) {
        pluginInstalled = true;
      },
      dispose() {
        pluginDisposed = true;
      },
    };

    const agent = await Agent.create({
      name: "test-agent",
      model: provider,
      plugins: [testPlugin],
    });

    expect(pluginInstalled).toBe(true);

    await agent.dispose();
    expect(pluginDisposed).toBe(true);
  });

  it("should support hooks", async () => {
    const provider = new MockProvider([{ content: "result" }]);
    const hookCalls: string[] = [];

    const agent = await Agent.create({
      name: "test-agent",
      model: provider,
      hooks: {
        beforeModelCall() {
          hookCalls.push("beforeModelCall");
        },
        afterModelCall() {
          hookCalls.push("afterModelCall");
        },
      },
    });

    await agent.run("test");

    expect(hookCalls).toContain("beforeModelCall");
    expect(hookCalls).toContain("afterModelCall");

    await agent.dispose();
  });

  it("should handle tool not found gracefully", async () => {
    const provider = new MockProvider([
      {
        toolCalls: [
          { id: "tc1", name: "nonexistent", arguments: {} },
        ],
      },
      { content: "Sorry, tool not found" },
    ]);

    const agent = await Agent.create({
      name: "test-agent",
      model: provider,
    });

    const result = await agent.run("use tool");

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].status).toBe("error");

    await agent.dispose();
  });

  it("should respect maxTurns limit", async () => {
    // Always returns tool calls — would loop forever without maxTurns
    const provider = new MockProvider(
      Array(10).fill({
        toolCalls: [{ id: "tc1", name: "calculator", arguments: { expression: "1" } }],
      }),
    );

    const calculator = defineTool({
      name: "calculator",
      description: "Calculate",
      parameters: { type: "object", properties: { expression: { type: "string" } } },
      async execute() { return { result: 1 }; },
    });

    const agent = await Agent.create({
      name: "test-agent",
      model: provider,
      tools: [calculator],
      maxTurns: 3,
    });

    await agent.run("loop forever");

    // Should have been called exactly 3 times (maxTurns)
    expect(provider.calls).toHaveLength(3);

    await agent.dispose();
  });

  it("should deny tool calls with permission policy", async () => {
    const provider = new MockProvider([
      {
        toolCalls: [{ id: "tc1", name: "dangerous_tool", arguments: {} }],
      },
      { content: "Tool was denied" },
    ]);

    const dangerous = defineTool({
      name: "dangerous_tool",
      description: "Dangerous",
      parameters: { type: "object", properties: {} },
      riskLevel: "high",
      async execute() { return { done: true }; },
    });

    const agent = await Agent.create({
      name: "test-agent",
      model: provider,
      tools: [dangerous],
      permissions: {
        denyTools: ["dangerous_tool"],
      },
    });

    const result = await agent.run("do something dangerous");

    expect(result.toolCalls[0].status).toBe("denied");

    await agent.dispose();
  });

  it("should support plugin registering tools", async () => {
    const provider = new MockProvider([
      {
        toolCalls: [{ id: "tc1", name: "plugin_tool", arguments: { value: "test" } }],
      },
      { content: "Done with plugin tool" },
    ]);

    const toolPlugin: WallePlugin = {
      name: "tool-plugin",
      install(ctx: AgentContext) {
        ctx.registerTool({
          name: "plugin_tool",
          description: "A tool from a plugin",
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
          },
          async execute(input: { value: string }) {
            return { echo: input.value };
          },
        });
      },
    };

    const agent = await Agent.create({
      name: "test-agent",
      model: provider,
      plugins: [toolPlugin],
    });

    const result = await agent.run("use plugin tool");

    expect(result.toolCalls[0].status).toBe("success");
    expect(result.toolCalls[0].output).toEqual({ echo: "test" });

    await agent.dispose();
  });
});
