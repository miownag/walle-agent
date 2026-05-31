import { describe, it, expect, vi } from "vitest";
import {
  MCPClientManager,
  includeTool,
  type MCPClientFactory,
  type ManagedMCPClient,
} from "../src/mcp-client-manager.js";
import type { MCPServerConfig } from "../src/mcp-config.js";

interface FakeClient extends ManagedMCPClient {
  connect: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function makeFakeClient(tools: Array<{ name: string; description?: string }>): FakeClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({ tools }),
    callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeFactory(map: Record<string, FakeClient>): MCPClientFactory {
  return {
    create(config: MCPServerConfig) {
      const client = map[config.name];
      if (!client) {
        throw new Error(`unexpected server in test factory: ${config.name}`);
      }
      return { client, transport: { kind: "fake", config } };
    },
  };
}

describe("MCPClientManager", () => {
  it("connects, lists and disconnects a single server", async () => {
    const client = makeFakeClient([
      { name: "read_file", description: "read a file" },
      { name: "write_file" },
    ]);
    const factory = makeFactory({ fs: client });
    const manager = new MCPClientManager(
      [{ name: "fs", transport: { type: "stdio", command: "noop" } }],
      factory,
    );

    await manager.connectAll();
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(manager.serverNames()).toEqual(["fs"]);

    const tools = await manager.listTools();
    expect(client.listTools).toHaveBeenCalledTimes(1);
    expect(tools.map((t) => t.name)).toEqual([
      "mcp_fs_read_file",
      "mcp_fs_write_file",
    ]);

    await manager.disconnectAll();
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(manager.serverNames()).toEqual([]);
  });

  it("connectAll is idempotent for multiple calls", async () => {
    const client = makeFakeClient([{ name: "noop" }]);
    const factory = makeFactory({ fs: client });
    const manager = new MCPClientManager(
      [{ name: "fs", transport: { type: "stdio", command: "noop" } }],
      factory,
    );

    await manager.connectAll();
    await manager.connectAll();
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it("applies enabledTools as a whitelist", async () => {
    const client = makeFakeClient([
      { name: "read_file" },
      { name: "write_file" },
      { name: "delete_file" },
    ]);
    const factory = makeFactory({ fs: client });
    const manager = new MCPClientManager(
      [
        {
          name: "fs",
          transport: { type: "stdio", command: "noop" },
          enabledTools: ["read_file", "write_file"],
        },
      ],
      factory,
    );

    await manager.connectAll();
    const tools = await manager.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "mcp_fs_read_file",
      "mcp_fs_write_file",
    ]);
  });

  it("applies disabledTools as a blacklist", async () => {
    const client = makeFakeClient([
      { name: "read_file" },
      { name: "write_file" },
      { name: "delete_file" },
    ]);
    const factory = makeFactory({ fs: client });
    const manager = new MCPClientManager(
      [
        {
          name: "fs",
          transport: { type: "stdio", command: "noop" },
          disabledTools: ["delete_file"],
        },
      ],
      factory,
    );

    await manager.connectAll();
    const tools = await manager.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "mcp_fs_read_file",
      "mcp_fs_write_file",
    ]);
  });

  it("intersects whitelist and blacklist", async () => {
    const client = makeFakeClient([
      { name: "a" },
      { name: "b" },
      { name: "c" },
    ]);
    const factory = makeFactory({ fs: client });
    const manager = new MCPClientManager(
      [
        {
          name: "fs",
          transport: { type: "stdio", command: "noop" },
          enabledTools: ["a", "b"],
          disabledTools: ["b"],
        },
      ],
      factory,
    );

    await manager.connectAll();
    const tools = await manager.listTools();
    expect(tools.map((t) => t.name)).toEqual(["mcp_fs_a"]);
  });

  it("supports multiple servers with default prefixes", async () => {
    const fsClient = makeFakeClient([{ name: "read" }]);
    const ghClient = makeFakeClient([{ name: "read" }]);
    const factory = makeFactory({ fs: fsClient, gh: ghClient });
    const manager = new MCPClientManager(
      [
        { name: "fs", transport: { type: "stdio", command: "noop" } },
        { name: "gh", transport: { type: "http", url: "https://example.com/mcp" } },
      ],
      factory,
    );

    await manager.connectAll();
    const tools = await manager.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "mcp_fs_read",
      "mcp_gh_read",
    ]);
  });

  it("rejects duplicate server names at connectAll time", async () => {
    const client = makeFakeClient([]);
    const factory = makeFactory({ fs: client });
    const manager = new MCPClientManager(
      [
        { name: "fs", transport: { type: "stdio", command: "noop" } },
        { name: "fs", transport: { type: "stdio", command: "noop" } },
      ],
      factory,
    );

    await expect(manager.connectAll()).rejects.toThrow(/Duplicate MCP server name/);
  });

  it("logs but swallows errors from client.close()", async () => {
    const client = makeFakeClient([]);
    client.close = vi.fn().mockRejectedValue(new Error("close failed"));
    const factory = makeFactory({ fs: client });
    const manager = new MCPClientManager(
      [{ name: "fs", transport: { type: "stdio", command: "noop" } }],
      factory,
    );

    await manager.connectAll();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(manager.disconnectAll()).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("includeTool helper", () => {
  const base: MCPServerConfig = {
    name: "x",
    transport: { type: "stdio", command: "noop" },
  };

  it("treats empty lists as no-filter", () => {
    expect(includeTool("foo", { ...base, enabledTools: [], disabledTools: [] })).toBe(true);
  });

  it("requires membership when whitelist is non-empty", () => {
    expect(includeTool("foo", { ...base, enabledTools: ["bar"] })).toBe(false);
    expect(includeTool("bar", { ...base, enabledTools: ["bar"] })).toBe(true);
  });

  it("excludes on blacklist", () => {
    expect(includeTool("foo", { ...base, disabledTools: ["foo"] })).toBe(false);
  });
});
