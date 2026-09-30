import { describe, it, expect, vi } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Agent } from "../src/agent.js";
import { defineTool } from "../src/tool.js";
import type { AgentStreamEvent } from "../src/stream.js";
import type {
  LLMChatResponse,
  LLMProvider,
  LLMStreamChunk,
} from "../src/llm-provider.js";
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

  it("forwards each provider completion usage to the stream event, hook, and result", async () => {
    const usage = {
      promptTokens: 13,
      completionTokens: 5,
      totalTokens: 18,
      cacheReadTokens: 7,
    };
    const hookUsages: Array<typeof usage | undefined> = [];
    const provider: LLMProvider = {
      name: "usage-provider",
      async chat(): Promise<LLMChatResponse> {
        return {
          message: { role: "assistant", content: "measured" },
          usage,
        };
      },
      async *stream(): AsyncIterable<LLMStreamChunk> {
        const message = { role: "assistant" as const, content: "measured" };
        yield { type: "text_delta", content: "measured" };
        yield { type: "message_complete", message, usage };
      },
    };
    const agent = await Agent.create({
      name: "usage-agent",
      model: provider,
      hooks: {
        afterModelCall(payload) {
          hookUsages.push(payload.usage);
        },
      },
    });

    const result = await agent.run("measure this call");
    const modelCallEnd = result.events.find(
      (event) => event.type === "model_call_end",
    );

    expect(modelCallEnd).toMatchObject({
      type: "model_call_end",
      usage,
    });
    expect(hookUsages).toEqual([usage]);
    expect(result.usage).toEqual(usage);

    await agent.dispose();
  });

  it("mirrors each provider thinking chunk exactly once while retaining llm_chunk", async () => {
    const completeMessage = { role: "assistant" as const, content: "answer" };
    const provider: LLMProvider = {
      name: "thinking-provider",
      async chat(): Promise<LLMChatResponse> {
        return { message: completeMessage };
      },
      async *stream(): AsyncIterable<LLMStreamChunk> {
        yield { type: "thinking_delta", content: "reasoning" };
        yield { type: "text_delta", content: "answer" };
        yield { type: "message_complete", message: completeMessage };
      },
    };

    const agent = await Agent.create({
      name: "thinking-agent",
      model: provider,
    });
    const events: AgentStreamEvent[] = [];
    for await (const event of agent.run("think", { stream: true })) {
      events.push(event);
    }

    const rawThinking = events.filter(
      (event) =>
        event.type === "llm_chunk" && event.chunk.type === "thinking_delta",
    );
    const mirroredThinking = events.filter(
      (event) => event.type === "thinking_delta",
    );
    expect(rawThinking).toHaveLength(1);
    expect(mirroredThinking).toEqual([
      { type: "thinking_delta", content: "reasoning" },
    ]);
    expect(events.indexOf(mirroredThinking[0])).toBe(
      events.indexOf(rawThinking[0]) + 1,
    );

    await agent.dispose();
  });

  it("registers workspace-bound filesystem built-ins per Agent", async () => {
    const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "walle-workspace-"));
    const outsideRoot = await fs.mkdtemp(join(tmpdir(), "walle-outside-"));
    const outsideFile = join(outsideRoot, "secret.txt");
    await fs.writeFile(outsideFile, "secret");

    const provider = new MockProvider([
      {
        toolCalls: [
          { id: "tc1", name: "read_file", arguments: { path: outsideFile } },
        ],
      },
      { content: "done" },
    ]);
    const agent = await Agent.create({
      name: "workspace-agent",
      model: provider,
      workspaceRoot,
      useBuiltinTools: { includeTools: ["read_file"] },
    });

    try {
      const result = await agent.run("read outside");
      expect(result.toolCalls[0].status).toBe("success");
      expect(result.toolCalls[0].output).toMatchObject({
        error: expect.stringContaining("workspaceRoot"),
      });
    } finally {
      await agent.dispose();
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("registers isolated plan and todo tools for each Agent", async () => {
    const first = await Agent.create({
      name: "stateful-tools-first",
      model: new MockProvider([]),
    });
    const second = await Agent.create({
      name: "stateful-tools-second",
      model: new MockProvider([]),
    });

    try {
      const firstPlan = first
        .listVisibleTools()
        .find((tool) => tool.name === "plan")!;
      const secondPlan = second
        .listVisibleTools()
        .find((tool) => tool.name === "plan")!;
      const firstTodos = first
        .listVisibleTools()
        .find((tool) => tool.name === "write_todos")!;
      const secondTodos = second
        .listVisibleTools()
        .find((tool) => tool.name === "write_todos")!;

      expect(firstPlan).not.toBe(secondPlan);
      expect(firstTodos).not.toBe(secondTodos);

      await firstPlan.execute({
        action: "create",
        title: "First agent plan",
        steps: [{ content: "private step" }],
      });
      await firstTodos.execute({ action: "add", task: "First agent todo" });

      expect((await firstPlan.execute({ action: "list" })).totalPlans).toBe(1);
      expect((await secondPlan.execute({ action: "list" })).totalPlans).toBe(0);
      expect((await firstTodos.execute({ action: "list" })).totalTasks).toBe(1);
      expect((await secondTodos.execute({ action: "list" })).totalTasks).toBe(
        0,
      );
    } finally {
      await first.dispose();
      await second.dispose();
    }
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

    const calculator = defineTool(
      "calculator",
      "Calculate math expressions",
      { expression: z.string() },
      async (input) => {
        // Simple eval for test
        return { result: eval(input.expression) };
      },
    );

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

  it.each([
    {
      label: "successful",
      output: {
        stdout: "ok\n",
        stderr: "",
        exitCode: 0,
        durationMs: 3,
        timedOut: false,
      },
      expectedStatus: "success" as const,
      expectedError: undefined,
    },
    {
      label: "non-zero",
      output: {
        stdout: "partial output\n",
        stderr: "command failed\n",
        exitCode: 2,
        durationMs: 4,
        timedOut: false,
      },
      expectedStatus: "error" as const,
      expectedError: "Shell command exited with code 2",
    },
    {
      label: "timed-out",
      output: {
        stdout: "output before timeout\n",
        stderr: "",
        exitCode: 137,
        durationMs: 5,
        timedOut: true,
      },
      expectedStatus: "timeout" as const,
      expectedError: "Shell command timed out",
    },
  ])(
    "maps a resolved $label shell result to $expectedStatus without dropping output",
    async ({ output, expectedStatus, expectedError }) => {
      const provider = new MockProvider([
        {
          toolCalls: [
            { id: "shell-call", name: "sandbox_shell", arguments: {} },
          ],
        },
        { content: "Done." },
      ]);
      const shell = defineTool(
        "sandbox_shell",
        "Execute a sandboxed shell command",
        {},
        async () => output,
        { tags: ["shell"] },
      );
      const agent = await Agent.create({
        name: `resolved-shell-${expectedStatus}`,
        model: provider,
        tools: [shell],
      });

      try {
        const result = await agent.run("run command");
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0]).toMatchObject({
          status: expectedStatus,
          output,
        });
        expect(result.toolCalls[0].error).toBe(expectedError);
      } finally {
        await agent.dispose();
      }
    },
  );

  it("should use system prompt", async () => {
    const provider = new MockProvider([{ content: "I am helpful" }]);

    const agent = await Agent.create({
      name: "test-agent",
      model: provider,
      systemPrompt: "You are a helpful assistant.",
    });

    await agent.run("hello");

    expect(provider.calls[0].messages[0].role).toBe("system");
    expect(provider.calls[0].messages[0].content).toContain(
      "You are a helpful assistant.",
    );

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

  it("releases the active run when a run_end event listener throws", async () => {
    const provider = new MockProvider([
      { content: "first" },
      { content: "second" },
    ]);
    let failNextRunEnd = true;
    const listenerError = new Error("run_end listener failed");

    const plugin: WallePlugin = {
      name: "throwing-run-end-listener",
      install(ctx) {
        ctx.events.on("run_end", () => {
          if (failNextRunEnd) {
            failNextRunEnd = false;
            throw listenerError;
          }
        });
      },
    };

    const agent = await Agent.create({
      name: "run-end-listener-agent",
      model: provider,
      plugins: [plugin],
    });

    try {
      await expect(agent.run("first run")).rejects.toBe(listenerError);
      expect(agent.isRunning).toBe(false);

      await expect(agent.run("second run")).resolves.toMatchObject({
        content: "second",
      });
      expect(agent.isRunning).toBe(false);
    } finally {
      await agent.dispose();
    }
  });

  it("releases the active run when an onRunEnd hook reports an error", async () => {
    const provider = new MockProvider([
      { content: "first" },
      { content: "second" },
    ]);
    const hookError = new Error("onRunEnd hook failed");
    let hookCalls = 0;
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const agent = await Agent.create({
      name: "run-end-hook-agent",
      model: provider,
      hooks: {
        onRunEnd() {
          hookCalls += 1;
          if (hookCalls === 1) throw hookError;
        },
      },
    });

    try {
      // HookManager deliberately isolates hook failures, so the run itself
      // succeeds while teardown still has to release its active slot.
      await expect(agent.run("first run")).resolves.toMatchObject({
        content: "first",
      });
      expect(agent.isRunning).toBe(false);

      await expect(agent.run("second run")).resolves.toMatchObject({
        content: "second",
      });
      expect(agent.isRunning).toBe(false);
      expect(hookCalls).toBe(2);
      expect(consoleError).toHaveBeenCalledWith(
        "[Hook onRunEnd] Error:",
        hookError,
      );
    } finally {
      await agent.dispose();
      consoleError.mockRestore();
    }
  });

  it("should handle tool not found gracefully", async () => {
    const provider = new MockProvider([
      {
        toolCalls: [{ id: "tc1", name: "nonexistent", arguments: {} }],
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
        toolCalls: [
          { id: "tc1", name: "calculator", arguments: { expression: "1" } },
        ],
      }),
    );

    const calculator = defineTool(
      "calculator",
      "Calculate",
      { expression: z.string() },
      async () => ({ result: 1 }),
    );

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

    const dangerous = defineTool(
      "dangerous_tool",
      "Dangerous",
      {},
      async () => ({ done: true }),
      { riskLevel: "high" },
    );

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
        toolCalls: [
          { id: "tc1", name: "plugin_tool", arguments: { value: "test" } },
        ],
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
