import { describe, it, expect, vi } from "vitest";
import type { Agent, AgentResult } from "@walle-agent/core";
import { createSubAgentTool, slugifyToolName } from "../src/sub-agent-tool.js";

function fakeAgent(name: string, content: string = "ok"): Agent {
  const result: AgentResult = { content, messages: [], toolCalls: [], events: [] };
  return {
    name,
    id: `id-${name}`,
    sessionId: `s-${name}`,
    run: vi.fn(async () => result),
  } as unknown as Agent;
}

describe("slugifyToolName", () => {
  it("lowercases and replaces non-alphanumerics with underscores", () => {
    expect(slugifyToolName("My Researcher 1")).toBe("my_researcher_1");
  });

  it("preserves hyphens and underscores", () => {
    expect(slugifyToolName("agent-1_alpha")).toBe("agent-1_alpha");
  });

  it("trims edge underscores and caps at 60 chars", () => {
    expect(slugifyToolName("!!!hello!!!")).toBe("hello");
    expect(slugifyToolName("x".repeat(80)).length).toBe(60);
  });

  it("falls back to 'agent' when input slugifies to empty", () => {
    expect(slugifyToolName("!!!")).toBe("agent");
    expect(slugifyToolName("   ")).toBe("agent");
  });
});

describe("createSubAgentTool", () => {
  it("produces the spec'd tool shape", () => {
    const tool = createSubAgentTool(fakeAgent("Researcher"));
    expect(tool.name).toBe("delegate_researcher");
    expect(tool.riskLevel).toBe("low");
    expect(tool.tags).toEqual(["sub-agent"]);
    expect(tool.parameters).toMatchObject({
      type: "object",
      required: ["task"],
    });
    expect((tool.parameters as { properties: Record<string, unknown> }).properties.task).toMatchObject({
      type: "string",
    });
  });

  it("slugifies the agent name into the tool name", () => {
    const tool = createSubAgentTool(fakeAgent("My Researcher 1"));
    expect(tool.name).toBe("delegate_my_researcher_1");
  });

  it("options.name overrides the auto-generated slug", () => {
    const tool = createSubAgentTool(fakeAgent("Researcher"), { name: "ask_research" });
    expect(tool.name).toBe("ask_research");
  });

  it("options.description overrides the default", () => {
    const tool = createSubAgentTool(fakeAgent("Researcher"), { description: "custom desc" });
    expect(tool.description).toBe("custom desc");
  });

  it("execute() forwards the task to agent.run and returns its content", async () => {
    const agent = fakeAgent("Researcher", "the answer");
    const tool = createSubAgentTool(agent);
    const out = await tool.execute({ task: "think hard" }, { agent } as any);
    expect(out).toEqual({ result: "the answer" });
    expect((agent.run as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("think hard");
    expect((agent.run as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });
});
