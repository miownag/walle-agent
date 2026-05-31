import { describe, it, expect, vi } from "vitest";
import { adaptMCPTool, flattenMCPResult } from "../src/mcp-tool-adapter.js";
import type { MCPClientLike } from "../src/mcp-tool-adapter.js";
import type { MCPServerConfig } from "../src/mcp-config.js";

const cfg = (over: Partial<MCPServerConfig> = {}): MCPServerConfig => ({
  name: "demo",
  transport: { type: "stdio", command: "noop" },
  ...over,
});

const fakeCtx = { agent: {} as any } as any;

describe("adaptMCPTool — naming & metadata", () => {
  it("applies the default mcp_<server>_<tool> prefix", () => {
    const tool = adaptMCPTool({
      serverName: "demo",
      client: { callTool: vi.fn() } as MCPClientLike,
      mcpTool: { name: "read_file" },
      config: cfg(),
    });

    expect(tool.name).toBe("mcp_demo_read_file");
    expect(tool.tags).toEqual(["mcp", "demo"]);
  });

  it("honours a custom toolPrefix verbatim", () => {
    const tool = adaptMCPTool({
      serverName: "demo",
      client: { callTool: vi.fn() } as MCPClientLike,
      mcpTool: { name: "read_file" },
      config: cfg({ toolPrefix: "fs_" }),
    });

    expect(tool.name).toBe("fs_read_file");
  });

  it("falls back to 'MCP tool from <server>' when description is missing", () => {
    const tool = adaptMCPTool({
      serverName: "demo",
      client: { callTool: vi.fn() } as MCPClientLike,
      mcpTool: { name: "read_file" },
      config: cfg(),
    });

    expect(tool.description).toBe("MCP tool from demo");
  });

  it("uses the provided description when non-empty", () => {
    const tool = adaptMCPTool({
      serverName: "demo",
      client: { callTool: vi.fn() } as MCPClientLike,
      mcpTool: { name: "read_file", description: "Read a file from disk" },
      config: cfg(),
    });

    expect(tool.description).toBe("Read a file from disk");
  });

  it("falls back to an empty object-schema when inputSchema is missing", () => {
    const tool = adaptMCPTool({
      serverName: "demo",
      client: { callTool: vi.fn() } as MCPClientLike,
      mcpTool: { name: "no_schema" },
      config: cfg(),
    });

    expect(tool.parameters).toEqual({ type: "object", properties: {} });
  });

  it("passes the provided inputSchema through", () => {
    const schema = {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    };
    const tool = adaptMCPTool({
      serverName: "demo",
      client: { callTool: vi.fn() } as MCPClientLike,
      mcpTool: { name: "schema", inputSchema: schema },
      config: cfg(),
    });

    expect(tool.parameters).toBe(schema);
  });
});

describe("adaptMCPTool — execute path", () => {
  it("forwards the name + arguments to client.callTool", async () => {
    const callTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
    const tool = adaptMCPTool({
      serverName: "demo",
      client: { callTool } as MCPClientLike,
      mcpTool: { name: "do_thing" },
      config: cfg(),
    });

    const result = await tool.execute({ path: "./README.md" }, fakeCtx);

    expect(callTool).toHaveBeenCalledWith({
      name: "do_thing",
      arguments: { path: "./README.md" },
    });
    expect(result).toBe("ok");
  });

  it("flattens multi-text content blocks with newlines", async () => {
    const callTool = vi.fn().mockResolvedValue({
      content: [
        { type: "text", text: "line 1" },
        { type: "text", text: "line 2" },
      ],
    });
    const tool = adaptMCPTool({
      serverName: "demo",
      client: { callTool } as MCPClientLike,
      mcpTool: { name: "multi" },
      config: cfg(),
    });

    expect(await tool.execute({}, fakeCtx)).toBe("line 1\nline 2");
  });

  it("JSON-stringifies non-text blocks and mixes them in", async () => {
    const callTool = vi.fn().mockResolvedValue({
      content: [
        { type: "text", text: "head" },
        { type: "image", mimeType: "image/png", data: "abc" },
      ],
    });
    const tool = adaptMCPTool({
      serverName: "demo",
      client: { callTool } as MCPClientLike,
      mcpTool: { name: "mixed" },
      config: cfg(),
    });

    const out = await tool.execute({}, fakeCtx);
    expect(out.startsWith("head\n")).toBe(true);
    expect(out).toContain("\"type\":\"image\"");
  });

  it("JSON-stringifies the whole result when content is absent", async () => {
    const callTool = vi.fn().mockResolvedValue({ foo: "bar" });
    const tool = adaptMCPTool({
      serverName: "demo",
      client: { callTool } as MCPClientLike,
      mcpTool: { name: "bare" },
      config: cfg(),
    });

    expect(await tool.execute({}, fakeCtx)).toBe("{\"foo\":\"bar\"}");
  });

  it("throws when isError is true, using the flattened message", async () => {
    const callTool = vi.fn().mockResolvedValue({
      isError: true,
      content: [{ type: "text", text: "boom" }],
    });
    const tool = adaptMCPTool({
      serverName: "demo",
      client: { callTool } as MCPClientLike,
      mcpTool: { name: "bad" },
      config: cfg(),
    });

    await expect(tool.execute({}, fakeCtx)).rejects.toThrow("boom");
  });

  it("passes empty arguments as {} when input is undefined", async () => {
    const callTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
    const tool = adaptMCPTool({
      serverName: "demo",
      client: { callTool } as MCPClientLike,
      mcpTool: { name: "nullary" },
      config: cfg(),
    });

    await tool.execute(undefined as any, fakeCtx);

    expect(callTool).toHaveBeenCalledWith({
      name: "nullary",
      arguments: {},
    });
  });
});

describe("flattenMCPResult helper", () => {
  it("handles empty content arrays", () => {
    expect(flattenMCPResult({ content: [] })).toBe("");
  });

  it("falls back to raw JSON when content is missing", () => {
    expect(flattenMCPResult({ foo: 1 })).toBe("{\"foo\":1}");
  });
});
