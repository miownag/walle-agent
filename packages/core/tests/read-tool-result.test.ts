/**
 * Tests for the built-in `read_tool_result` tool.
 */

import { describe, it, expect } from "vitest";
import { readToolResultTool } from "../src/builtin-tools/read-tool-result.js";
import { EventBus } from "../src/events.js";
import type { ToolExecutionContext } from "../src/tool.js";
import type { Agent } from "../src/agent.js";

function mkCtx(events?: EventBus): ToolExecutionContext {
  return {
    agent: {
      name: "a",
      sessionId: "s",
      getEventBus: () => events,
    } as unknown as Agent,
  };
}

describe("readToolResultTool", () => {
  it("rejects empty toolCallId", async () => {
    const out = (await readToolResultTool.execute(
      { toolCallId: "" } as never,
      mkCtx(new EventBus()),
    )) as { error: string };
    expect(out.error).toMatch(/toolCallId/);
  });

  it("returns error when no agent EventBus is available", async () => {
    const out = (await readToolResultTool.execute(
      { toolCallId: "abc" },
      { agent: { name: "a", sessionId: "s" } as unknown as Agent },
    )) as { error: string };
    expect(out.error).toMatch(/EventBus|memory/);
  });

  it("returns error when no listener writes a value", async () => {
    const events = new EventBus();
    const out = (await readToolResultTool.execute(
      { toolCallId: "abc" },
      mkCtx(events),
    )) as { error: string };
    expect(out.error).toMatch(/vault not available/);
  });

  it("returns the slice that the listener writes back", async () => {
    const events = new EventBus();
    events.on("vault_read", (payload) => {
      payload.result.value = {
        content: "line1\nline2",
        totalLines: 2,
        truncated: false,
      };
    });
    const out = await readToolResultTool.execute(
      { toolCallId: "abc", offset: 0, limit: 5 },
      mkCtx(events),
    );
    expect(out).toEqual({
      content: "line1\nline2",
      totalLines: 2,
      truncated: false,
    });
  });

  it("normalises negative offset to 0 and 0 limit to 1", async () => {
    const events = new EventBus();
    let seenOffset = -1;
    let seenLimit = -1;
    events.on("vault_read", (payload) => {
      seenOffset = payload.offset;
      seenLimit = payload.limit;
      payload.result.value = { content: "", totalLines: 0, truncated: false };
    });
    await readToolResultTool.execute(
      { toolCallId: "id", offset: -5, limit: 0 },
      mkCtx(events),
    );
    expect(seenOffset).toBe(0);
    expect(seenLimit).toBe(1);
  });
});
