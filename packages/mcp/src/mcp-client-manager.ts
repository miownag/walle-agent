/**
 * MCPClientManager — owns the lifecycle of one Client per configured server
 * and exposes their tools as internal `Tool` instances.
 *
 * The heavy lifting (spawning a child process, negotiating the MCP handshake,
 * shuttling JSON-RPC messages) is delegated to the official
 * `@modelcontextprotocol/sdk` client. We only keep a structural seam
 * (`MCPClientFactory`) so tests can inject a fake without needing the full
 * SDK.
 */

import type { Tool } from "@walle-agent/core";
import type {
  MCPServerConfig,
  MCPStdioTransportConfig,
  MCPStreamableHTTPTransportConfig,
} from "./mcp-config.js";
import {
  adaptMCPTool,
  type MCPClientLike,
  type MCPToolDescriptor,
} from "./mcp-tool-adapter.js";

// ─── Minimal structural type for an MCP client ────────────────────────────

export interface ManagedMCPClient extends MCPClientLike {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: MCPToolDescriptor[] }>;
  close(): Promise<void>;
}

export interface MCPClientEntry {
  client: ManagedMCPClient;
  transport: unknown;
  config: MCPServerConfig;
}

export interface MCPClientFactory {
  create(config: MCPServerConfig): {
    client: ManagedMCPClient;
    transport: unknown;
  };
}

// ─── Default factory (uses the real MCP SDK) ──────────────────────────────

async function defaultFactoryCreate(config: MCPServerConfig): Promise<{
  client: ManagedMCPClient;
  transport: unknown;
}> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const transport = await createDefaultTransport(config);
  const client = new Client({
    name: config.clientName ?? `walle-agent-${config.name}`,
    version: config.clientVersion ?? "1.0.0",
  });
  return { client: client as unknown as ManagedMCPClient, transport };
}

async function createDefaultTransport(config: MCPServerConfig): Promise<unknown> {
  switch (config.transport.type) {
    case "stdio": {
      const t = config.transport as MCPStdioTransportConfig;
      const { StdioClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/stdio.js"
      );
      return new StdioClientTransport({
        command: t.command,
        args: t.args ?? [],
        env: t.env,
        cwd: t.cwd,
      });
    }
    case "http": {
      const t = config.transport as MCPStreamableHTTPTransportConfig;
      const { StreamableHTTPClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/streamableHttp.js"
      );
      return new StreamableHTTPClientTransport(new URL(t.url), {
        requestInit: t.headers ? { headers: t.headers } : undefined,
      });
    }
    default: {
      const exhaustive: never = config.transport;
      throw new Error(
        `Unsupported MCP transport: ${(exhaustive as { type?: string })?.type}`,
      );
    }
  }
}

export const defaultMCPClientFactory: MCPClientFactory = {
  create(_config: MCPServerConfig) {
    // The default factory is async under the hood but `create` is declared
    // sync to match the structural interface. We return a "deferred" pair
    // wrapped in a harness that awaits the real create on first use.
    //
    // In practice `connectAll` is the only caller and it `await`s everything,
    // so we take a simpler route: expose a sync wrapper that throws if the
    // SDK isn't loaded, and let `MCPClientManager` route through an internal
    // async path. This keeps the public factory interface simple for tests.
    throw new Error(
      "defaultMCPClientFactory.create() is a placeholder — `MCPClientManager` uses its internal async bootstrap when no factory is supplied.",
    );
  },
};

// ─── Manager ──────────────────────────────────────────────────────────────

export class MCPClientManager {
  private readonly entries = new Map<string, MCPClientEntry>();
  private connected = false;

  constructor(
    private readonly configs: MCPServerConfig[],
    private readonly factory?: MCPClientFactory,
  ) {}

  /** Snapshot of currently-registered server names. */
  serverNames(): string[] {
    return [...this.entries.keys()];
  }

  /** Access a connected entry by server name (mainly for tests). */
  getEntry(name: string): MCPClientEntry | undefined {
    return this.entries.get(name);
  }

  async connectAll(): Promise<void> {
    if (this.connected) return;

    for (const config of this.configs) {
      if (this.entries.has(config.name)) {
        throw new Error(`Duplicate MCP server name: ${config.name}`);
      }

      const { client, transport } = await this.createClient(config);
      await client.connect(transport);
      this.entries.set(config.name, { client, transport, config });
    }

    this.connected = true;
  }

  async listTools(): Promise<Tool[]> {
    const result: Tool[] = [];

    for (const [serverName, entry] of this.entries) {
      const response = await entry.client.listTools();
      const tools = Array.isArray(response?.tools) ? response.tools : [];

      for (const mcpTool of tools) {
        if (!includeTool(mcpTool.name, entry.config)) continue;
        result.push(
          adaptMCPTool({
            serverName,
            client: entry.client,
            mcpTool,
            config: entry.config,
          }),
        );
      }
    }

    return result;
  }

  async disconnectAll(): Promise<void> {
    const errors: unknown[] = [];
    for (const [, entry] of this.entries) {
      try {
        await entry.client.close();
      } catch (err) {
        errors.push(err);
      }
    }
    this.entries.clear();
    this.connected = false;

    if (errors.length) {
      for (const err of errors) {
        // Preserve the "never throw during dispose" contract but still surface
        // failures for debugging.
        console.error("[mcp] error during client.close():", err);
      }
    }
  }

  // ─── internals ──────────────────────────────────────────────────────────

  private async createClient(config: MCPServerConfig): Promise<{
    client: ManagedMCPClient;
    transport: unknown;
  }> {
    if (this.factory) {
      return this.factory.create(config);
    }
    return defaultFactoryCreate(config);
  }
}

// ─── Filters ──────────────────────────────────────────────────────────────

function hasEntries(list: string[] | undefined): list is string[] {
  return Array.isArray(list) && list.length > 0;
}

export function includeTool(
  toolName: string,
  config: MCPServerConfig,
): boolean {
  if (hasEntries(config.enabledTools) && !config.enabledTools.includes(toolName)) {
    return false;
  }
  if (hasEntries(config.disabledTools) && config.disabledTools.includes(toolName)) {
    return false;
  }
  return true;
}
