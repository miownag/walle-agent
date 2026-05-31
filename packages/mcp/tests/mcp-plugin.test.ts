import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "@walle-agent/core";
import { MCPPlugin } from "../src/mcp-plugin.js";
import type {
  MCPClientFactory,
  ManagedMCPClient,
} from "../src/mcp-client-manager.js";
import type { MCPServerConfig } from "../src/mcp-config.js";

function makeFakeClient(tools: Array<{ name: string }>): ManagedMCPClient & {
  connect: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({ tools }),
    callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeFactory(
  map: Record<string, ReturnType<typeof makeFakeClient>>,
): MCPClientFactory {
  return {
    create(config: MCPServerConfig) {
      const client = map[config.name];
      if (!client) throw new Error(`no fake client for ${config.name}`);
      return { client, transport: {} };
    },
  };
}

function makeCtx(): {
  ctx: any;
  registry: ToolRegistry;
} {
  const registry = new ToolRegistry();
  const ctx = {
    registerTool: (t: any) => registry.register(t),
    registerHook: vi.fn(),
    registerMiddleware: vi.fn(),
    events: { on: vi.fn(), emit: vi.fn() },
    agent: {} as any,
    config: {} as any,
    getPlugin: () => undefined,
  };
  return { ctx, registry };
}

describe("MCPPlugin", () => {
  it("registers tools discovered from each server during install", async () => {
    const fs = makeFakeClient([{ name: "read" }, { name: "write" }]);
    const gh = makeFakeClient([{ name: "list_issues" }]);
    const plugin = new MCPPlugin(
      [
        { name: "fs", transport: { type: "stdio", command: "noop" } },
        { name: "gh", transport: { type: "http", url: "https://example.com/mcp" } },
      ],
      { factory: makeFactory({ fs, gh }) },
    );

    const { ctx, registry } = makeCtx();
    await plugin.install(ctx);

    expect(registry.list().map((t) => t.name).sort()).toEqual([
      "mcp_fs_read",
      "mcp_fs_write",
      "mcp_gh_list_issues",
    ]);
  });

  it("attaches the manager on ctx.__mcpManager", async () => {
    const fs = makeFakeClient([{ name: "noop" }]);
    const plugin = new MCPPlugin(
      [{ name: "fs", transport: { type: "stdio", command: "noop" } }],
      { factory: makeFactory({ fs }) },
    );

    const { ctx } = makeCtx();
    await plugin.install(ctx);

    expect(ctx.__mcpManager).toBe(plugin.manager);
  });

  it("honours enabledTools / disabledTools at install time", async () => {
    const fs = makeFakeClient([{ name: "read" }, { name: "write" }, { name: "delete" }]);
    const plugin = new MCPPlugin(
      [
        {
          name: "fs",
          transport: { type: "stdio", command: "noop" },
          enabledTools: ["read", "write"],
          disabledTools: ["write"],
        },
      ],
      { factory: makeFactory({ fs }) },
    );

    const { ctx, registry } = makeCtx();
    await plugin.install(ctx);

    expect(registry.list().map((t) => t.name)).toEqual(["mcp_fs_read"]);
  });

  it("dispose closes every client", async () => {
    const fs = makeFakeClient([{ name: "read" }]);
    const gh = makeFakeClient([{ name: "list_issues" }]);
    const plugin = new MCPPlugin(
      [
        { name: "fs", transport: { type: "stdio", command: "noop" } },
        { name: "gh", transport: { type: "http", url: "https://example.com/mcp" } },
      ],
      { factory: makeFactory({ fs, gh }) },
    );

    const { ctx } = makeCtx();
    await plugin.install(ctx);
    await plugin.dispose();

    expect(fs.close).toHaveBeenCalledTimes(1);
    expect(gh.close).toHaveBeenCalledTimes(1);
  });

  it("dispose continues when one client close throws", async () => {
    const fs = makeFakeClient([]);
    fs.close = vi.fn().mockRejectedValue(new Error("boom"));
    const gh = makeFakeClient([]);
    const plugin = new MCPPlugin(
      [
        { name: "fs", transport: { type: "stdio", command: "noop" } },
        { name: "gh", transport: { type: "http", url: "https://example.com/mcp" } },
      ],
      { factory: makeFactory({ fs, gh }) },
    );

    const { ctx } = makeCtx();
    await plugin.install(ctx);

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(plugin.dispose()).resolves.toBeUndefined();
    expect(gh.close).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("tool execute path calls through to client.callTool", async () => {
    const fs = makeFakeClient([{ name: "read" }]);
    const plugin = new MCPPlugin(
      [{ name: "fs", transport: { type: "stdio", command: "noop" } }],
      { factory: makeFactory({ fs }) },
    );

    const { ctx, registry } = makeCtx();
    await plugin.install(ctx);

    const tool = registry.get("mcp_fs_read")!;
    const result = await tool.execute(
      { path: "./foo" },
      { agent: {} as any },
    );

    expect(fs.callTool).toHaveBeenCalledWith({
      name: "read",
      arguments: { path: "./foo" },
    });
    expect(result).toBe("ok");
  });
});
