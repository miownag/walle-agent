import { describe, it, expect, vi } from "vitest";
import type { LLMProvider, LLMChatRequest, LLMStreamChunk, ModelMessage } from "@walle-agent/core";
import { Agent } from "@walle-agent/core";
import { SubAgentsPlugin } from "../src/sub-agents-plugin.js";

class StubProvider implements LLMProvider {
  name = "stub";
  calls: LLMChatRequest[] = [];

  async chat(request: LLMChatRequest) {
    this.calls.push(request);
    const message: ModelMessage = { role: "assistant", content: "stub" };
    return { message };
  }

  async *stream(request: LLMChatRequest): AsyncIterable<LLMStreamChunk> {
    this.calls.push(request);
    const message: ModelMessage = { role: "assistant", content: "stub" };
    yield { type: "text_delta", content: "stub" };
    yield { type: "message_complete", message };
  }
}

describe("SubAgentsPlugin", () => {
  it("registers types into ctx.subAgents during install", async () => {
    const provider = new StubProvider();
    const plugin = new SubAgentsPlugin({
      types: [
        { type: "researcher", systemPrompt: "research", model: provider, useBuiltinTools: false },
        { type: "coder", systemPrompt: "code", model: provider, useBuiltinTools: false },
      ],
    });

    const agent = await Agent.create({
      name: "Parent",
      model: provider,
      plugins: [plugin],
    });

    const registry = plugin.getRegistry();
    expect(registry.types().sort()).toEqual(["coder", "researcher"]);
    expect(registry.has("researcher")).toBe(true);

    // The built-in `task` tool should now reflect both types in its
    // schema. We trigger a stream so we can read what the LLM sees.
    const stream = agent.run("hi", { stream: true });
    for await (const _ of stream) {
      void _;
    }
    const tools = provider.calls[0].tools ?? [];
    const taskDef = tools.find((t) => t.function.name === "task");
    expect(taskDef).toBeDefined();
    expect(taskDef!.function.description).toMatch(/researcher/);
    expect(taskDef!.function.description).toMatch(/coder/);

    await agent.dispose();
  });

  it("throws when both AgentConfig.subAgents and SubAgentsPlugin are used", async () => {
    const provider = new StubProvider();
    const plugin = new SubAgentsPlugin({
      types: [{ type: "x", model: provider, useBuiltinTools: false }],
    });

    await expect(
      Agent.create({
        name: "Conflict",
        model: provider,
        subAgents: [{ type: "y", model: provider, useBuiltinTools: false }],
        plugins: [plugin],
      }),
    ).rejects.toThrow(/AgentConfig\.subAgents is already populated/);
  });

  it("getRegistry() throws if install has not run", () => {
    const plugin = new SubAgentsPlugin({ types: [] });
    expect(() => plugin.getRegistry()).toThrow(/install\(\) has not been called/);
  });

  it("constructor rejects malformed options", () => {
    expect(
      () =>
        new SubAgentsPlugin({
          // @ts-expect-error: deliberately wrong type
          types: undefined,
        }),
    ).toThrow();
  });

  it("delegates to a registered sub-agent end-to-end via the task tool", async () => {
    const parentProvider = new StubProvider();
    const childProvider = new StubProvider();

    // Override parent provider to issue one task tool call, then a final reply.
    parentProvider.stream = async function* (request: LLMChatRequest) {
      this.calls.push(request);
      const turn = this.calls.length;
      if (turn === 1) {
        const message: ModelMessage = {
          role: "assistant",
          content: undefined,
          toolCalls: [
            {
              id: "tc1",
              name: "task",
              arguments: {
                subagent_type: "echo",
                description: "echo",
                prompt: "hi",
              },
            },
          ],
        };
        yield {
          type: "tool_call_delta",
          toolCallId: "tc1",
          name: "task",
          argumentsDelta: JSON.stringify({
            subagent_type: "echo",
            description: "echo",
            prompt: "hi",
          }),
        };
        yield {
          type: "message_complete",
          message,
          toolCalls: message.toolCalls,
        };
      } else {
        const message: ModelMessage = { role: "assistant", content: "DONE" };
        yield { type: "text_delta", content: "DONE" };
        yield { type: "message_complete", message };
      }
    } as LLMProvider["stream"];

    const plugin = new SubAgentsPlugin({
      types: [
        {
          type: "echo",
          systemPrompt: "echo back",
          model: childProvider,
          useBuiltinTools: false,
        },
      ],
    });

    const agent = await Agent.create({
      name: "Parent",
      model: parentProvider,
      plugins: [plugin],
    });

    const result = await agent.run("call echo");
    const taskCall = result.toolCalls.find((c) => c.name === "task");
    expect(taskCall).toBeDefined();
    expect(taskCall!.status).toBe("success");
    expect(taskCall!.output).toEqual({ result: "stub" });
    expect(childProvider.calls.length).toBe(1);

    await agent.dispose();
  });
});
