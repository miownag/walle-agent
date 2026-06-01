import { describe, it, expect, vi } from "vitest";
import { Agent } from "../src/agent.js";
import { defineTool } from "../src/tool.js";
import { SubAgentRegistry } from "../src/sub-agent-registry.js";
import { createTaskTool, TASK_TOOL_NAME } from "../src/builtin-tools/task-tool.js";
import type { TaskToolOutput } from "../src/builtin-tools/task-tool.js";
import type { Tool, ToolExecutionContext } from "../src/tool.js";
import { MockProvider } from "./mock-provider.js";

// Convenience: invoke a Tool's execute() with a minimal ToolExecutionContext.
async function callTask(
  tool: Tool,
  input: unknown,
  ctx: Partial<ToolExecutionContext> & { agent: Agent },
): Promise<TaskToolOutput> {
  return (await tool.execute(input, ctx as ToolExecutionContext)) as TaskToolOutput;
}

describe("createTaskTool", () => {
  it("registers as `task` by default and is included in the built-in set", async () => {
    const provider = new MockProvider([{ content: "ignored" }]);
    const agent = await Agent.create({
      name: "Parent",
      model: provider,
      subAgents: [{ type: "researcher", systemPrompt: "Research." }],
    });

    // The agent's tool registry should now expose `task`.
    // We don't have a public getter, but listing tools via stream events would
    // be heavy — instead, build a fresh task tool and assert its shape.
    const tool = createTaskTool({
      registry: new SubAgentRegistry(),
      defaultModel: provider,
    });
    expect(tool.name).toBe(TASK_TOOL_NAME);
    expect(tool.tags).toContain("sub-agent");
    expect(tool.riskLevel).toBe("low");
    expect((tool.parameters as { required: string[] }).required).toEqual([
      "subagent_type",
      "description",
      "prompt",
    ]);

    await agent.dispose();
  });

  it("dispatches to a registered sub-agent and returns its content", async () => {
    const parentProvider = new MockProvider([{ content: "parent" }]);
    const childProvider = new MockProvider([{ content: "child says hi" }]);

    const registry = new SubAgentRegistry();
    registry.register({
      type: "researcher",
      systemPrompt: "You are a researcher.",
      model: childProvider,
      useBuiltinTools: false,
    });

    const parent = await Agent.create({ name: "Parent", model: parentProvider });
    const tool = createTaskTool({ registry, defaultModel: parentProvider });

    const out = await callTask(
      tool,
      { subagent_type: "researcher", description: "test", prompt: "What is 2+2?" },
      { agent: parent, signal: undefined },
    );
    expect(out).toEqual({ result: "child says hi" });

    await parent.dispose();
  });

  it("returns { error, available } for unknown subagent_type without throwing", async () => {
    const parentProvider = new MockProvider([{ content: "parent" }]);
    const registry = new SubAgentRegistry();
    registry.register({ type: "researcher", model: parentProvider });
    registry.register({ type: "coder", model: parentProvider });

    const parent = await Agent.create({ name: "Parent", model: parentProvider });
    const tool = createTaskTool({ registry, defaultModel: parentProvider });

    const out = await callTask(
      tool,
      { subagent_type: "ghost", description: "x", prompt: "y" },
      { agent: parent },
    );
    expect("error" in out).toBe(true);
    if ("error" in out) {
      expect(out.error).toMatch(/unknown subagent_type/);
      expect(out.available?.sort()).toEqual(["coder", "researcher"]);
    }

    await parent.dispose();
  });

  it("returns verbose payload (messages + toolCalls) when def.verbose is true", async () => {
    const parentProvider = new MockProvider([{ content: "parent" }]);
    const childProvider = new MockProvider([{ content: "verbose child" }]);

    const registry = new SubAgentRegistry();
    registry.register({
      type: "verbose-bot",
      model: childProvider,
      useBuiltinTools: false,
      verbose: true,
    });

    const parent = await Agent.create({ name: "Parent", model: parentProvider });
    const tool = createTaskTool({ registry, defaultModel: parentProvider });

    const out = await callTask(
      tool,
      { subagent_type: "verbose-bot", description: "x", prompt: "go" },
      { agent: parent },
    );
    expect("result" in out).toBe(true);
    if ("result" in out) {
      expect(out.result).toBe("verbose child");
      expect(Array.isArray(out.messages)).toBe(true);
      expect(Array.isArray(out.toolCalls)).toBe(true);
    }

    await parent.dispose();
  });

  it("falls back to defaultModel when SubAgentDefinition.model is unset", async () => {
    const parentProvider = new MockProvider([{ content: "parent" }]);
    const inheritedProvider = new MockProvider([{ content: "inherited" }]);

    const registry = new SubAgentRegistry();
    registry.register({ type: "no-model", useBuiltinTools: false });

    const parent = await Agent.create({ name: "Parent", model: parentProvider });
    const tool = createTaskTool({ registry, defaultModel: inheritedProvider });

    const out = await callTask(
      tool,
      { subagent_type: "no-model", description: "x", prompt: "go" },
      { agent: parent },
    );
    expect(out).toEqual({ result: "inherited" });
    expect(inheritedProvider.calls.length).toBe(1);

    await parent.dispose();
  });

  it("returns an error when no model is available", async () => {
    const parentProvider = new MockProvider([{ content: "parent" }]);
    const registry = new SubAgentRegistry();
    registry.register({ type: "no-model" });

    const parent = await Agent.create({ name: "Parent", model: parentProvider });
    // Note: no defaultModel passed.
    const tool = createTaskTool({ registry });

    const out = await callTask(
      tool,
      { subagent_type: "no-model", description: "x", prompt: "go" },
      { agent: parent },
    );
    expect("error" in out).toBe(true);
    if ("error" in out) {
      expect(out.error).toMatch(/no model available/i);
    }

    await parent.dispose();
  });

  it("inheritSession=true reuses parent sessionId; default false generates a new one", async () => {
    const parentProvider = new MockProvider([
      { content: "p1" },
      { content: "p2" },
    ]);
    const childProvider = new MockProvider([
      { content: "share" },
      { content: "isolate" },
    ]);

    const registry = new SubAgentRegistry();
    registry.register({
      type: "sharer",
      model: childProvider,
      useBuiltinTools: false,
      inheritSession: true,
    });
    registry.register({
      type: "isolated",
      model: childProvider,
      useBuiltinTools: false,
    });

    // We can't observe sessionId directly from the task output, so spy on
    // Agent.create to capture what got passed.
    const createSpy = vi.spyOn(Agent, "create");

    const parent = await Agent.create({ name: "Parent", model: parentProvider });
    const tool = createTaskTool({ registry, defaultModel: parentProvider });

    await callTask(
      tool,
      { subagent_type: "sharer", description: "x", prompt: "go" },
      { agent: parent },
    );

    const sharedCall = createSpy.mock.calls.at(-1)?.[0];
    expect(sharedCall?.sessionId).toBe(parent.sessionId);

    await callTask(
      tool,
      { subagent_type: "isolated", description: "x", prompt: "go" },
      { agent: parent },
    );

    const isolatedCall = createSpy.mock.calls.at(-1)?.[0];
    // `sessionId` is not set when inheritSession is false → undefined.
    expect(isolatedCall?.sessionId).toBeUndefined();

    createSpy.mockRestore();
    await parent.dispose();
  });

  it("propagates ctx.signal to child.run", async () => {
    const parentProvider = new MockProvider([{ content: "parent" }]);
    const childProvider = new MockProvider([{ content: "child" }]);

    const registry = new SubAgentRegistry();
    registry.register({ type: "watcher", model: childProvider, useBuiltinTools: false });

    const parent = await Agent.create({ name: "Parent", model: parentProvider });
    const tool = createTaskTool({ registry, defaultModel: parentProvider });

    const controller = new AbortController();
    await callTask(
      tool,
      { subagent_type: "watcher", description: "x", prompt: "go" },
      { agent: parent, signal: controller.signal },
    );

    // The child provider's stream(...) was called with a signal that ultimately
    // tracks the parent controller. We assert the request carries some signal.
    expect(childProvider.calls.length).toBe(1);
    expect(childProvider.calls[0].signal).toBeDefined();
    await parent.dispose();
  });

  it("disposes the child agent even when run throws", async () => {
    const parentProvider = new MockProvider([{ content: "parent" }]);
    const childProvider = new MockProvider([{ content: "child" }]);

    const registry = new SubAgentRegistry();
    registry.register({ type: "rich", model: childProvider, useBuiltinTools: false });

    const parent = await Agent.create({ name: "Parent", model: parentProvider });
    const tool = createTaskTool({ registry, defaultModel: parentProvider });

    // Spy on Agent.create's returned instance dispose to make sure it gets called.
    const realCreate = Agent.create.bind(Agent);
    const createSpy = vi
      .spyOn(Agent, "create")
      .mockImplementation(async (cfg) => {
        const child = await realCreate(cfg);
        const origDispose = child.dispose.bind(child);
        child.dispose = vi.fn(async () => origDispose());
        // Force run to throw to verify dispose still happens.
        child.run = vi.fn(async () => {
          throw new Error("boom");
        }) as Agent["run"];
        return child;
      });

    let caught: unknown;
    try {
      await callTask(
        tool,
        { subagent_type: "rich", description: "x", prompt: "go" },
        { agent: parent },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);

    // The most-recent Agent.create call's returned instance should have had
    // dispose called.
    const lastReturn = await createSpy.mock.results.at(-1)?.value;
    expect(lastReturn?.dispose).toHaveBeenCalledTimes(1);

    createSpy.mockRestore();
    await parent.dispose();
  });

  it("rejects malformed input without crashing", async () => {
    const parentProvider = new MockProvider([{ content: "p" }]);
    const registry = new SubAgentRegistry();
    registry.register({ type: "x", model: parentProvider });

    const parent = await Agent.create({ name: "Parent", model: parentProvider });
    const tool = createTaskTool({ registry, defaultModel: parentProvider });

    const noPrompt = await callTask(
      tool,
      { subagent_type: "x", description: "y", prompt: "" },
      { agent: parent },
    );
    expect("error" in noPrompt).toBe(true);

    const noType = await callTask(
      tool,
      { subagent_type: undefined, description: "y", prompt: "z" },
      { agent: parent },
    );
    expect("error" in noType).toBe(true);

    await parent.dispose();
  });

  it("description enumerates registered types", () => {
    const registry = new SubAgentRegistry();
    registry.register({ type: "researcher", description: "Research stuff" });
    registry.register({ type: "coder" });
    const provider = new MockProvider([{ content: "x" }]);
    const tool = createTaskTool({ registry, defaultModel: provider });
    expect(tool.description).toMatch(/researcher/);
    expect(tool.description).toMatch(/coder/);
    const subagentTypeDesc = (tool.parameters as {
      properties: { subagent_type: { description: string } };
    }).properties.subagent_type.description;
    expect(subagentTypeDesc).toMatch(/researcher/);
    expect(subagentTypeDesc).toMatch(/Research stuff/);
  });
});

describe("AgentRuntime.registerTaskTool integration", () => {
  it("registers `task` by default in a freshly-created Agent", async () => {
    const provider = new MockProvider([
      // First turn: call task.
      {
        toolCalls: [
          {
            id: "tc1",
            name: "task",
            arguments: {
              subagent_type: "echo",
              description: "echo back",
              prompt: "hello",
            },
          },
        ],
      },
      // Second turn: final answer.
      { content: "child said: hello" },
    ]);
    const childProvider = new MockProvider([{ content: "echoed!" }]);

    const agent = await Agent.create({
      name: "ParentWithTask",
      model: provider,
      subAgents: [
        { type: "echo", model: childProvider, useBuiltinTools: false },
      ],
    });

    const result = await agent.run("trigger task");
    expect(result.toolCalls.some((c) => c.name === "task")).toBe(true);
    const taskCall = result.toolCalls.find((c) => c.name === "task")!;
    expect(taskCall.status).toBe("success");
    expect(taskCall.output).toEqual({ result: "echoed!" });

    await agent.dispose();
  });

  it("respects useBuiltinTools.excludeTools to disable `task`", async () => {
    const provider = new MockProvider([
      {
        toolCalls: [
          {
            id: "tc1",
            name: "task",
            arguments: {
              subagent_type: "echo",
              description: "x",
              prompt: "y",
            },
          },
        ],
      },
      { content: "done" },
    ]);

    const agent = await Agent.create({
      name: "NoTask",
      model: provider,
      useBuiltinTools: { excludeTools: ["task"] },
      subAgents: [{ type: "echo", model: provider, useBuiltinTools: false }],
    });

    const result = await agent.run("call task");
    const taskCall = result.toolCalls.find((c) => c.name === "task")!;
    expect(taskCall.output).toMatchObject({ error: expect.stringMatching(/Tool not found/) });

    await agent.dispose();
  });

  it("respects useBuiltinTools.includeTools to allow only `task`", async () => {
    const provider = new MockProvider([{ content: "ok" }]);

    const agent = await Agent.create({
      name: "OnlyTask",
      model: provider,
      useBuiltinTools: { includeTools: ["task"] },
    });

    // Trigger a stream and inspect the request — the LLM call should see only
    // one tool definition: `task`.
    const stream = agent.run("hi", { stream: true });
    for await (const _ of stream) {
      void _;
    }
    expect(provider.calls.length).toBe(1);
    const tools = provider.calls[0].tools ?? [];
    expect(tools.length).toBe(1);
    expect(tools[0].function.name).toBe("task");

    await agent.dispose();
  });

  it("user-supplied `task` tool wins over the built-in", async () => {
    const provider = new MockProvider([{ content: "x" }]);

    const customTask = defineTool({
      name: "task",
      description: "custom override",
      parameters: { type: "object" },
      async execute() {
        return { custom: true };
      },
    });

    const agent = await Agent.create({
      name: "OverrideTask",
      model: provider,
      tools: [customTask],
    });

    // Stream so we can read what the LLM sees.
    const stream = agent.run("hi", { stream: true });
    for await (const _ of stream) {
      void _;
    }
    const tools = provider.calls[0].tools ?? [];
    const taskDef = tools.find((t) => t.function.name === "task");
    expect(taskDef?.function.description).toBe("custom override");

    await agent.dispose();
  });
});
