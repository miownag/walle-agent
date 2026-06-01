/**
 * Tests for the Memory plugin's `compact_messages` listener (micro
 * compression) and `vault_read` listener (read_tool_result backend).
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EventBus, ToolRegistry, AgentContextImpl } from "@walle-agent/core";
import type { ModelMessage } from "@walle-agent/core";
import { HookManager, MiddlewarePipeline } from "@walle-agent/core";
import { SubAgentRegistry } from "@walle-agent/core";
import { MemoryPlugin } from "../src/memory-plugin.js";

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "walle-compact-"));
  return dir;
}

function makeContext(plugin: MemoryPlugin): { events: EventBus; ctx: AgentContextImpl } {
  const events = new EventBus();
  const toolRegistry = new ToolRegistry();
  const hookManager = new HookManager();
  const middlewarePipeline = new MiddlewarePipeline();
  const subAgents = new SubAgentRegistry();

  const ctx = new AgentContextImpl({
    // The compact handler doesn't touch agent / config, so stubs are fine.
    agent: {} as never,
    config: {} as never,
    events,
    toolRegistry,
    hookManager,
    middlewarePipeline,
    subAgents,
  });

  void plugin;
  return { events, ctx };
}

const sys = (text: string): ModelMessage => ({ role: "system", content: text });
const user = (text: string): ModelMessage => ({ role: "user", content: text });
const asst = (text: string): ModelMessage => ({ role: "assistant", content: text });
const tool = (id: string, content: string, name = "do"): ModelMessage => ({
  role: "tool",
  toolCallId: id,
  content,
  metadata: { toolName: name, status: "success" },
});

describe("MemoryPlugin compact_messages (micro)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tmpDir();
  });

  it("rewrites tool messages outside the recent N turns into placeholders", async () => {
    const plugin = new MemoryPlugin({
      rootDir: dir,
      sessions: { enabled: false },
      longTerm: { enabled: false },
      toolResults: { keepRecentTurns: 3 },
    });
    const { events, ctx } = makeContext(plugin);
    await plugin.install(ctx);

    const messages: ModelMessage[] = [
      sys("you are walle"),
      user("hi"),
      asst("a1"),
      tool("id1", "X".repeat(50)),
      asst("a2"),
      tool("id2", "Y".repeat(50)),
      asst("a3"),
      tool("id3", "Z".repeat(50)),
      asst("a4"),
      tool("id4", "W".repeat(50)),
    ];

    await events.emit("compact_messages", {
      messages,
      keepRecentTurns: 3,
      runId: "r1",
      sessionId: "s1",
    });

    // Turns: a1(2), a2(4), a3(6), a4(8). keepRecentTurns=3 → cutoff = turnStarts[1] = 4 (a2).
    // Indices < 4 are evictable; >= 4 protected.
    expect(messages[3].content).toMatch(/^\[ToolResult #/); // turn1 evicted
    expect(messages[5].content).not.toMatch(/^\[ToolResult #/); // turn2 kept
    expect(messages[7].content).not.toMatch(/^\[ToolResult #/); // turn3 kept
    expect(messages[9].content).not.toMatch(/^\[ToolResult #/); // turn4 kept

    await plugin.dispose?.();
  });

  it("is a no-op when fewer turns than keepRecentTurns", async () => {
    const plugin = new MemoryPlugin({
      rootDir: dir,
      sessions: { enabled: false },
      longTerm: { enabled: false },
    });
    const { events, ctx } = makeContext(plugin);
    await plugin.install(ctx);

    const messages: ModelMessage[] = [
      sys("s"),
      asst("a"),
      tool("id1", "X".repeat(50)),
    ];
    const before = messages[2].content;
    await events.emit("compact_messages", {
      messages,
      keepRecentTurns: 3,
      runId: "r1",
    });
    expect(messages[2].content).toBe(before);
    await plugin.dispose?.();
  });

  it("respects thresholdChars > 0 to keep small outputs verbatim", async () => {
    const plugin = new MemoryPlugin({
      rootDir: dir,
      sessions: { enabled: false },
      longTerm: { enabled: false },
      toolResults: { thresholdChars: 1000, keepRecentTurns: 1 },
    });
    const { events, ctx } = makeContext(plugin);
    await plugin.install(ctx);

    const small = "small";
    const big = "X".repeat(2000);

    const messages: ModelMessage[] = [
      asst("a1"),
      tool("id-small", small),
      asst("a2"),
      tool("id-big", big),
      asst("a3"),
    ];
    await events.emit("compact_messages", {
      messages,
      keepRecentTurns: 1,
      runId: "r1",
    });
    // tail (turn 3 only) protected; turn 1 and turn 2 evictable.
    // Small output should remain verbatim because its size <= threshold.
    expect(messages[1].content).toBe(small);
    expect(messages[3].content).toMatch(/^\[ToolResult #/);
    await plugin.dispose?.();
  });
});

describe("MemoryPlugin vault_read (read_tool_result backend)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tmpDir();
  });

  it("returns the slice from the vault", async () => {
    const plugin = new MemoryPlugin({
      rootDir: dir,
      sessions: { enabled: false },
      longTerm: { enabled: false },
    });
    const { events, ctx } = makeContext(plugin);
    await plugin.install(ctx);
    if (!plugin.vault) throw new Error("vault expected");

    await plugin.vault.ensure({
      toolCallId: "abc",
      toolName: "x",
      content: "line1\nline2\nline3\nline4",
      status: "success",
    });

    const result: { value?: unknown } = {};
    await events.emit("vault_read", {
      toolCallId: "abc",
      offset: 1,
      limit: 2,
      result,
    });
    expect(result.value).toEqual({
      content: "line2\nline3",
      totalLines: 4,
      truncated: true,
    });
  });

  it("returns error when toolCallId is unknown", async () => {
    const plugin = new MemoryPlugin({
      rootDir: dir,
      sessions: { enabled: false },
      longTerm: { enabled: false },
    });
    const { events, ctx } = makeContext(plugin);
    await plugin.install(ctx);

    const result: { value?: unknown } = {};
    await events.emit("vault_read", {
      toolCallId: "missing",
      offset: 0,
      limit: 100,
      result,
    });
    expect(result.value).toEqual({ error: "tool result not found" });
  });
});
