/**
 * MCPPlugin — registers tools exposed by configured MCP servers on the
 * Agent's ToolRegistry. One plugin instance owns one `MCPClientManager`.
 *
 * Usage:
 *
 * ```ts
 * new MCPPlugin([
 *   { name: "filesystem", transport: { type: "stdio", command: "npx", args: ["…"] } },
 * ])
 * ```
 */

import type { AgentContext, WallePlugin } from "@walle-agent/core";
import type { MCPServerConfig } from "./mcp-config.js";
import {
  MCPClientManager,
  type MCPClientFactory,
  type MCPClientManagerOptions,
} from "./mcp-client-manager.js";

export interface MCPPluginOptions {
  /** Inject a custom client factory (mainly for tests). */
  factory?: MCPClientFactory;
  /** Abort a pending server handshake/tool discovery. */
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  listToolsTimeoutMs?: number;
  toolCallTimeoutMs?: number;
  closeTimeoutMs?: number;
  onClientInvalidated?: (serverName: string, reason: unknown) => void;
}

export class MCPPlugin implements WallePlugin {
  readonly name = "mcp";
  readonly version = "0.1.0";

  readonly manager: MCPClientManager;

  constructor(
    private readonly configs: MCPServerConfig[],
    options: MCPPluginOptions = {},
  ) {
    const managerOptions: MCPClientManagerOptions = {
      signal: options.signal,
      connectTimeoutMs: options.connectTimeoutMs,
      listToolsTimeoutMs: options.listToolsTimeoutMs,
      toolCallTimeoutMs: options.toolCallTimeoutMs,
      closeTimeoutMs: options.closeTimeoutMs,
      onClientInvalidated: options.onClientInvalidated,
    };
    this.manager = new MCPClientManager(this.configs, options.factory, managerOptions);
  }

  async install(ctx: AgentContext): Promise<void> {
    try {
      await this.manager.connectAll();

      const tools = await this.manager.listTools();
      for (const tool of tools) {
        ctx.registerTool(tool);
      }
    } catch (error) {
      await this.manager.disconnectAll();
      throw error;
    }

    // Expose the manager so other plugins can reach it (e.g. a future
    // permissions plugin that wants to whitelist MCP tools). Matches the
    // `ctx.__memoryManager` / `ctx.__skillRegistry` precedent.
    (ctx as unknown as { __mcpManager?: MCPClientManager }).__mcpManager =
      this.manager;
  }

  async dispose(): Promise<void> {
    try {
      await this.manager.disconnectAll();
    } catch (err) {
      // `disconnectAll` already logs and swallows individual errors; this is
      // a belt-and-braces guard in case the manager itself throws.
      console.error("[mcp] error during dispose():", err);
    }
  }
}
