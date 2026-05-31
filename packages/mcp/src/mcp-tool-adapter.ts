/**
 * MCP tool → internal Tool adapter.
 *
 * Kept dependency-free of the MCP SDK so it's trivial to unit-test with a
 * fake client that satisfies `MCPClientLike`. The real SDK client happens to
 * satisfy this shape.
 */

import type { Tool, ToolExecutionContext } from "@walle-agent/core";
import type { MCPServerConfig } from "./mcp-config.js";

// ─── Narrow structural types ──────────────────────────────────────────────

export interface MCPToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
  [k: string]: unknown;
}

export interface MCPContentBlock {
  type: string;
  text?: string;
  [k: string]: unknown;
}

export interface MCPToolCallResult {
  content?: MCPContentBlock[];
  isError?: boolean;
  [k: string]: unknown;
}

export interface MCPClientLike {
  callTool(params: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<MCPToolCallResult>;
}

// ─── Adapter ──────────────────────────────────────────────────────────────

export interface AdaptMCPToolOptions {
  serverName: string;
  client: MCPClientLike;
  mcpTool: MCPToolDescriptor;
  config: MCPServerConfig;
}

/**
 * Wrap an MCP tool descriptor as an internal Tool. Naming, description,
 * parameters and error routing are normalised here.
 */
export function adaptMCPTool(options: AdaptMCPToolOptions): Tool {
  const { serverName, client, mcpTool, config } = options;
  const prefix = config.toolPrefix ?? `mcp_${serverName}_`;
  const toolName = `${prefix}${mcpTool.name}`;

  const parameters =
    (mcpTool.inputSchema as Tool["parameters"] | undefined) ?? {
      type: "object",
      properties: {},
    };

  return {
    name: toolName,
    description:
      mcpTool.description && mcpTool.description.trim().length > 0
        ? mcpTool.description
        : `MCP tool from ${serverName}`,
    parameters,
    tags: ["mcp", serverName],

    async execute(
      input: Record<string, unknown>,
      _ctx: ToolExecutionContext,
    ): Promise<string> {
      const result = await client.callTool({
        name: mcpTool.name,
        arguments: input ?? {},
      });

      const flattened = flattenMCPResult(result);

      if (result.isError === true) {
        throw new Error(flattened);
      }

      return flattened;
    },
  };
}

/**
 * Flatten an MCP tool result to a single string suitable for a tool message.
 *
 * - If `content` is an array of blocks, text blocks are joined with "\n" and
 *   unknown block types are `JSON.stringify`'d.
 * - If `content` is absent, the whole result is `JSON.stringify`'d.
 */
export function flattenMCPResult(result: MCPToolCallResult): string {
  if (result.content && Array.isArray(result.content)) {
    return result.content
      .map((block) => {
        if (block.type === "text" && typeof block.text === "string") {
          return block.text;
        }
        try {
          return JSON.stringify(block);
        } catch {
          return String(block);
        }
      })
      .join("\n");
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}
