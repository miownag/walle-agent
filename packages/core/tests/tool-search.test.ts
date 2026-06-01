/**
 * Tests for `compileKeyword`, `scoreTool`, and `createToolSearchTool`.
 */

import { describe, it, expect } from "vitest";
import {
  compileKeyword,
  scoreTool,
  createToolSearchTool,
  deriveServerName,
} from "../src/builtin-tools/tool-search.js";
import { ToolRegistry } from "../src/tool-registry.js";
import { defineTool } from "../src/tool.js";
import { EventBus } from "../src/events.js";
import type { Tool } from "../src/tool.js";
import type { ToolExecutionContext } from "../src/tool.js";
import type { Agent } from "../src/agent.js";

function mkTool(
  name: string,
  description: string,
  tags: string[] = [],
  exec?: (input: unknown) => unknown,
): Tool {
  return defineTool({
    name,
    description,
    parameters: { type: "object", properties: {} },
    tags,
    riskLevel: "low",
    async execute(input) {
      if (exec) return exec(input);
      return `ran ${name}`;
    },
  });
}

function mkCtx(events?: EventBus): ToolExecutionContext {
  const stubAgent = {
    name: "test-agent",
    sessionId: "s",
    getEventBus: () => events,
  } as unknown as Agent;
  return { agent: stubAgent };
}

describe("compileKeyword", () => {
  it("compiles regex keyword", () => {
    const m = compileKeyword("/^fs_/i");
    expect(m.isRegex).toBe(true);
    expect(m.test("FS_read").matched).toBe(true);
    expect(m.test("nope").matched).toBe(false);
  });

  it("plain keyword: case-insensitive substring", () => {
    const m = compileKeyword("Read");
    expect(m.isRegex).toBe(false);
    expect(m.test("readFile").matched).toBe(true);
    expect(m.test("READ_LINE").matched).toBe(true);
    expect(m.test("xyz").matched).toBe(false);
  });

  it("plain keyword: detects whole-word matches", () => {
    const m = compileKeyword("read");
    expect(m.test("read").whole).toBe(true);
    expect(m.test("read a file").whole).toBe(true);
    expect(m.test("readline").whole).toBe(false);
    expect(m.test("readline").matched).toBe(true); // still substring
  });
});

describe("scoreTool", () => {
  const fsRead = mkTool("fs_read", "Read a file from disk", ["mcp", "fs"]);

  it("regex match in name → 1.0", () => {
    expect(scoreTool(fsRead, [compileKeyword("/^fs_/")])).toBe(1.0);
  });
  it("regex match in description only → 0.7", () => {
    expect(scoreTool(fsRead, [compileKeyword("/disk/")])).toBe(0.7);
  });
  it("whole-word in name → 0.8", () => {
    const t = mkTool("readFile", "no relevant terms", []);
    expect(scoreTool(t, [compileKeyword("readFile")])).toBe(0.8);
  });
  it("whole-word in description → 0.5", () => {
    expect(scoreTool(fsRead, [compileKeyword("file")])).toBe(0.5);
  });
  it("substring in name (e.g. underscore-separated) → 0.6", () => {
    // "read" is substring of "fs_read" but \b boundaries treat _ as word char,
    // so it's NOT a whole-word match — falls into substring tier.
    expect(scoreTool(fsRead, [compileKeyword("read")])).toBe(0.6);
  });
  it("substring in description → 0.3", () => {
    const t = mkTool("xyz", "Reading from disk", []);
    // "read" is not a whole word in "Reading"
    expect(scoreTool(t, [compileKeyword("read")])).toBe(0.3);
  });
  it("no match → 0", () => {
    expect(scoreTool(fsRead, [compileKeyword("zzz")])).toBe(0);
  });
  it("OR semantics: takes the max across keywords", () => {
    expect(
      scoreTool(fsRead, [compileKeyword("zzz"), compileKeyword("/^fs_/")]),
    ).toBe(1.0);
  });
});

describe("deriveServerName", () => {
  it("mcp tags → server name", () => {
    expect(deriveServerName(mkTool("a", "", ["mcp", "filesystem"]))).toBe(
      "filesystem",
    );
  });
  it("builtin tag → 'builtin'", () => {
    expect(deriveServerName(mkTool("a", "", ["builtin"]))).toBe("builtin");
  });
  it("no relevant tag → 'native'", () => {
    expect(deriveServerName(mkTool("a", "", []))).toBe("native");
  });
});

describe("createToolSearchTool", () => {
  function setup() {
    const r = new ToolRegistry();
    r.register(mkTool("fs_read", "Read a file", ["mcp", "fs"]));
    r.register(mkTool("fs_write", "Write a file", ["mcp", "fs"]));
    r.register(mkTool("bash", "Run shell command", ["builtin"]));
    return r;
  }

  it("returns sorted matches with metadata", async () => {
    const r = setup();
    const tool = createToolSearchTool({ registry: r });
    const out = (await tool.execute({ keywords: ["read"] }, mkCtx())) as {
      matches: Array<{ qualifiedName: string; score: number; server: string }>;
      totalCandidates: number;
      truncated: boolean;
    };
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0].qualifiedName).toBe("fs_read");
    expect(out.matches[0].server).toBe("fs");
    expect(out.matches[0].score).toBeGreaterThan(0);
  });

  it("filters by servers", async () => {
    const r = setup();
    const tool = createToolSearchTool({ registry: r });
    const out = (await tool.execute(
      { keywords: ["file"], servers: ["fs"] },
      mkCtx(),
    )) as { matches: Array<{ qualifiedName: string }> };
    expect(out.matches.every((m) => m.qualifiedName.startsWith("fs_"))).toBe(true);
  });

  it("filters by tags", async () => {
    const r = setup();
    const tool = createToolSearchTool({ registry: r });
    const out = (await tool.execute(
      { keywords: ["a"], tags: ["builtin"] },
      mkCtx(),
    )) as { matches: Array<{ qualifiedName: string }> };
    // Only "bash" matches "a" AND has tag "builtin"
    expect(out.matches.map((m) => m.qualifiedName)).toContain("bash");
    expect(out.matches.every((m) => m.qualifiedName !== "fs_read")).toBe(true);
  });

  it("respects limit and reports truncation", async () => {
    const r = new ToolRegistry();
    for (let i = 0; i < 25; i++) {
      r.register(mkTool(`tool_${i}`, "do read", ["mcp", "x"]));
    }
    const tool = createToolSearchTool({ registry: r });
    const out = (await tool.execute(
      { keywords: ["read"], limit: 5 },
      mkCtx(),
    )) as { matches: unknown[]; totalCandidates: number; truncated: boolean };
    expect(out.matches).toHaveLength(5);
    expect(out.totalCandidates).toBe(25);
    expect(out.truncated).toBe(true);
  });

  it("excludes self and defer_execute_tool from results", async () => {
    const r = new ToolRegistry();
    r.register(mkTool("tool_search", "...", ["builtin"]));
    r.register(mkTool("defer_execute_tool", "...", ["builtin"]));
    r.register(mkTool("real", "tool_search hint", ["builtin"]));
    const tool = createToolSearchTool({ registry: r });
    const out = (await tool.execute(
      { keywords: ["tool_search"] },
      mkCtx(),
    )) as { matches: Array<{ qualifiedName: string }> };
    expect(out.matches.every((m) => m.qualifiedName !== "tool_search")).toBe(
      true,
    );
    expect(
      out.matches.every((m) => m.qualifiedName !== "defer_execute_tool"),
    ).toBe(true);
  });

  it("returns empty for empty keywords", async () => {
    const r = setup();
    const tool = createToolSearchTool({ registry: r });
    const out = (await tool.execute({ keywords: [] }, mkCtx())) as {
      matches: unknown[];
    };
    expect(out.matches).toHaveLength(0);
  });

  it("returns error on invalid regex", async () => {
    const r = setup();
    const tool = createToolSearchTool({ registry: r });
    const out = (await tool.execute(
      { keywords: ["/[invalid/"] },
      mkCtx(),
    )) as { error?: string };
    expect(out.error).toBeDefined();
  });

  it("emits tool_search_done when EventBus is available", async () => {
    const events = new EventBus();
    const seen: unknown[] = [];
    events.on("tool_search_done", (p) => {
      seen.push(p);
    });
    const r = setup();
    const tool = createToolSearchTool({ registry: r });
    await tool.execute({ keywords: ["read"] }, mkCtx(events));
    expect(seen).toHaveLength(1);
  });
});
