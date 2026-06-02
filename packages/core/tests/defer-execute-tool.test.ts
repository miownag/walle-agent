/**
 * Tests for `createDeferExecuteTool`.
 */

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { createDeferExecuteTool } from "../src/builtin-tools/defer-execute-tool.js";
import { ToolRegistry } from "../src/tool-registry.js";
import { defineTool } from "../src/tool.js";
import { EventBus } from "../src/events.js";
import type { Tool, ToolExecutionContext } from "../src/tool.js";
import type { Agent } from "../src/agent.js";

function mkTool(
  name: string,
  description: string,
  tags: string[] = [],
  exec?: (input: unknown) => unknown,
): Tool {
  return defineTool(
    name,
    description,
    {},
    async (input) => {
      if (exec) return exec(input);
      return `ran ${name}`;
    },
    { tags, riskLevel: "low" },
  );
}

function mkCtx(events?: EventBus): ToolExecutionContext {
  return {
    agent: {
      name: "a",
      sessionId: "s",
      getEventBus: () => events,
    } as unknown as Agent,
  };
}

describe("createDeferExecuteTool", () => {
  it("executes a registered (shadow) tool", async () => {
    const r = new ToolRegistry();
    // Use a real schema so the args flow through zod.parse() untouched.
    const target = defineTool(
      "hidden",
      "...",
      { x: z.number() },
      async (input) => `out:${JSON.stringify(input)}`,
      { tags: ["mcp"], riskLevel: "low" },
    );
    r.register(target, { shadow: true });
    const tool = createDeferExecuteTool({
      registry: r,
      checkPermission: async () => ({ allowed: true }),
    });
    const out = await tool.execute(
      { qualifiedName: "hidden", arguments: { x: 1 } },
      mkCtx(),
    );
    expect(out).toBe('out:{"x":1}');
  });

  it("returns error on unknown qualifiedName", async () => {
    const r = new ToolRegistry();
    const tool = createDeferExecuteTool({
      registry: r,
      checkPermission: async () => ({ allowed: true }),
    });
    const out = (await tool.execute(
      { qualifiedName: "missing", arguments: {} },
      mkCtx(),
    )) as { error: string; qualifiedName?: string };
    expect(out.error).toBe("tool not found");
    expect(out.qualifiedName).toBe("missing");
  });

  it("rejects executing tool_search / defer_execute_tool", async () => {
    const r = new ToolRegistry();
    const tool = createDeferExecuteTool({
      registry: r,
      checkPermission: async () => ({ allowed: true }),
    });
    let out = (await tool.execute(
      { qualifiedName: "tool_search", arguments: {} },
      mkCtx(),
    )) as { error: string };
    expect(out.error).toMatch(/cannot defer-execute/);
    out = (await tool.execute(
      { qualifiedName: "defer_execute_tool", arguments: {} },
      mkCtx(),
    )) as { error: string };
    expect(out.error).toMatch(/cannot defer-execute/);
  });

  it("respects permission denial", async () => {
    const r = new ToolRegistry();
    r.register(mkTool("hidden", "...", ["mcp"]));
    const tool = createDeferExecuteTool({
      registry: r,
      checkPermission: async () => ({ allowed: false, reason: "nope" }),
    });
    const out = (await tool.execute(
      { qualifiedName: "hidden", arguments: {} },
      mkCtx(),
    )) as { error: string; reason?: string };
    expect(out.error).toBe("permission denied");
    expect(out.reason).toBe("nope");
  });

  it("converts thrown errors to {error}", async () => {
    const r = new ToolRegistry();
    r.register(
      mkTool("hidden", "...", ["mcp"], () => {
        throw new Error("boom");
      }),
    );
    const tool = createDeferExecuteTool({
      registry: r,
      checkPermission: async () => ({ allowed: true }),
    });
    const out = (await tool.execute(
      { qualifiedName: "hidden", arguments: {} },
      mkCtx(),
    )) as { error: string };
    expect(out.error).toBe("boom");
  });

  it("emits tool_defer_executed with status + duration", async () => {
    const r = new ToolRegistry();
    r.register(mkTool("hidden", "...", ["mcp"]));
    const events = new EventBus();
    const seen: Array<{
      qualifiedName: string;
      status: "success" | "error" | "denied";
      durationMs: number;
    }> = [];
    events.on("tool_defer_executed", (p) => {
      seen.push(p);
    });
    const tool = createDeferExecuteTool({
      registry: r,
      checkPermission: async () => ({ allowed: true }),
    });
    await tool.execute(
      { qualifiedName: "hidden", arguments: {} },
      mkCtx(events),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].status).toBe("success");
    expect(seen[0].qualifiedName).toBe("hidden");
  });

  it("requires qualifiedName", async () => {
    const r = new ToolRegistry();
    const tool = createDeferExecuteTool({
      registry: r,
      checkPermission: async () => ({ allowed: true }),
    });
    const out = (await tool.execute(
      { qualifiedName: "", arguments: {} } as never,
      mkCtx(),
    )) as { error: string };
    expect(out.error).toMatch(/qualifiedName/);
  });
});
