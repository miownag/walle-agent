/**
 * Integration tests for `applyToolSearchPolicy` end-to-end via `Agent.create`.
 */

import { describe, it, expect } from "vitest";
import { Agent } from "../src/agent.js";
import { defineTool } from "../src/tool.js";
import type { Tool } from "../src/tool.js";
import { MockProvider } from "./mock-provider.js";

function mkTool(name: string, tags: string[] = []): Tool {
  return defineTool({
    name,
    description: `tool ${name}`,
    parameters: { type: "object", properties: {} },
    tags,
    riskLevel: "low",
    async execute() {
      return `ran ${name}`;
    },
  });
}

function many(n: number, tags: string[] = []): Tool[] {
  return Array.from({ length: n }, (_, i) => mkTool(`mcp_x_tool_${i}`, tags));
}

describe("AgentRuntime tool-search policy", () => {
  it("does not shadow when total tools <= threshold (auto)", async () => {
    const agent = await Agent.create({
      name: "A",
      model: new MockProvider([{ content: "ok" }]),
      tools: many(3, ["mcp", "x"]),
      toolSearch: { enabled: true, mode: "auto", threshold: 30 },
      useBuiltinTools: { includeTools: ["tool_search", "defer_execute_tool"] },
    });
    expect(agent.listHiddenTools()).toHaveLength(0);
    expect(
      agent.listVisibleTools().map((t) => t.name).filter((n) => n === "tool_search"),
    ).toHaveLength(0);
    await agent.dispose();
  });

  it("shadows MCP-tagged tools when total > threshold (auto)", async () => {
    const agent = await Agent.create({
      name: "A",
      model: new MockProvider([{ content: "ok" }]),
      tools: many(50, ["mcp", "fake"]),
      toolSearch: { enabled: true, mode: "auto", threshold: 30 },
      useBuiltinTools: { includeTools: ["tool_search", "defer_execute_tool"] },
    });
    expect(agent.listHiddenTools()).toHaveLength(50);
    const visibleNames = agent.listVisibleTools().map((t) => t.name).sort();
    expect(visibleNames).toEqual(["defer_execute_tool", "tool_search"]);
    await agent.dispose();
  });

  it("force mode ignores threshold", async () => {
    const agent = await Agent.create({
      name: "A",
      model: new MockProvider([{ content: "ok" }]),
      tools: many(3, ["mcp", "fake"]),
      toolSearch: { enabled: true, mode: "force" },
      useBuiltinTools: { includeTools: ["tool_search", "defer_execute_tool"] },
    });
    expect(agent.listHiddenTools()).toHaveLength(3);
    await agent.dispose();
  });

  it("off mode keeps everything visible", async () => {
    const agent = await Agent.create({
      name: "A",
      model: new MockProvider([{ content: "ok" }]),
      tools: many(50, ["mcp", "fake"]),
      toolSearch: { enabled: false },
      useBuiltinTools: false,
    });
    expect(agent.listHiddenTools()).toHaveLength(0);
    await agent.dispose();
  });

  it("alwaysActiveTags wins over alwaysShadowTags", async () => {
    const tools = [mkTool("hybrid", ["mcp", "builtin"])];
    const agent = await Agent.create({
      name: "A",
      model: new MockProvider([{ content: "ok" }]),
      tools,
      toolSearch: { enabled: true, mode: "force" },
      useBuiltinTools: { includeTools: ["tool_search", "defer_execute_tool"] },
    });
    expect(agent.listHiddenTools()).toHaveLength(0);
    await agent.dispose();
  });

  it("does not register helpers when shadowable set is empty", async () => {
    const agent = await Agent.create({
      name: "A",
      model: new MockProvider([{ content: "ok" }]),
      tools: many(50, []), // no tags → not shadowable
      toolSearch: { enabled: true, mode: "force" },
      useBuiltinTools: { includeTools: ["tool_search", "defer_execute_tool"] },
    });
    expect(agent.listHiddenTools()).toHaveLength(0);
    expect(
      agent.listVisibleTools().some((t) => t.name === "tool_search"),
    ).toBe(false);
    await agent.dispose();
  });

  it("respects useBuiltinTools: false → does not shadow nor register helpers", async () => {
    const agent = await Agent.create({
      name: "A",
      model: new MockProvider([{ content: "ok" }]),
      tools: many(50, ["mcp", "x"]),
      toolSearch: { enabled: true, mode: "force" },
      useBuiltinTools: false,
    });
    // useBuiltinTools=false short-circuits the policy entirely.
    expect(agent.listHiddenTools()).toHaveLength(0);
    expect(agent.listVisibleTools().some((t) => t.name === "tool_search")).toBe(false);
    await agent.dispose();
  });

  it("warns when both helpers excluded but tools shadowable", async () => {
    const warns: unknown[] = [];
    const realWarn = console.warn;
    // eslint-disable-next-line no-console
    console.warn = (...args: unknown[]) => warns.push(args);
    try {
      const agent = await Agent.create({
        name: "A",
        model: new MockProvider([{ content: "ok" }]),
        tools: many(50, ["mcp", "x"]),
        toolSearch: { enabled: true, mode: "force" },
        useBuiltinTools: { excludeTools: ["tool_search", "defer_execute_tool"] },
      });
      expect(warns.length).toBeGreaterThan(0);
      await agent.dispose();
    } finally {
      // eslint-disable-next-line no-console
      console.warn = realWarn;
    }
  });
});
