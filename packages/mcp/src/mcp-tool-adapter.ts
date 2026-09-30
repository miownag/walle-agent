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
  }, resultSchema?: unknown, options?: {
    signal?: AbortSignal;
    timeout?: number;
    maxTotalTimeout?: number;
  }): Promise<MCPToolCallResult>;
}

// ─── Adapter ──────────────────────────────────────────────────────────────

export interface AdaptMCPToolOptions {
  serverName: string;
  client: MCPClientLike;
  mcpTool: MCPToolDescriptor;
  config: MCPServerConfig;
  /** Maximum duration for one MCP tool request. Default: 60 seconds. */
  callTimeoutMs?: number;
  /** Close/invalidate an unresponsive client after cancellation or timeout. */
  onUnresponsive?: (reason: unknown) => Promise<void> | void;
}

/**
 * Wrap an MCP tool descriptor as an internal Tool. Naming, description,
 * parameters and error routing are normalised here.
 */
export function adaptMCPTool(options: AdaptMCPToolOptions): Tool {
  const { serverName, client, mcpTool, config, onUnresponsive } = options;
  const callTimeoutMs = positiveTimeout(options.callTimeoutMs, 60_000);
  const prefix = config.toolPrefix ?? `mcp_${serverName}_`;
  const toolName = normalizeMCPToolName(`${prefix}${mcpTool.name}`);

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
      ctx: ToolExecutionContext,
    ): Promise<string> {
      const controller = new AbortController();
      const forwardAbort = () => controller.abort(ctx.signal?.reason);
      if (ctx.signal?.aborted) forwardAbort();
      else ctx.signal?.addEventListener("abort", forwardAbort, { once: true });
      const timeoutError = new Error(`MCP tool “${toolName}” timed out after ${callTimeoutMs}ms`);
      timeoutError.name = "TimeoutError";
      const timer = setTimeout(() => controller.abort(timeoutError), callTimeoutMs);
      timer.unref?.();
      const aborted = controller.signal.aborted
        ? Promise.reject<never>(abortError(toolName, controller.signal.reason))
        : new Promise<never>((_resolve, reject) => {
            controller.signal.addEventListener("abort", () => reject(abortError(toolName, controller.signal.reason)), { once: true });
          });
      let result: MCPToolCallResult;
      try {
        result = await Promise.race([
          client.callTool({
            name: mcpTool.name,
            arguments: input ?? {},
          }, undefined, {
            signal: controller.signal,
            timeout: callTimeoutMs,
            maxTotalTimeout: callTimeoutMs,
          }),
          aborted,
        ]);
      } catch (error) {
        if (controller.signal.aborted && onUnresponsive) {
          try {
            await onUnresponsive(error);
          } catch (closeError) {
            // eslint-disable-next-line no-console
            console.error(`[mcp] failed to close unresponsive client for ${toolName}:`, closeError);
          }
        }
        throw error;
      } finally {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", forwardAbort);
      }

      const flattened = flattenMCPResult(result);

      if (result.isError === true) {
        throw new Error(flattened);
      }

      return flattened;
    },
  };
}

/** Provider-safe, deterministic function name (`[A-Za-z0-9_-]`, max 64). */
export function normalizeMCPToolName(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || "mcp_tool";
  return normalized.slice(0, 64);
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function abortError(toolName: string, reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error(`MCP tool “${toolName}” cancelled${typeof reason === "string" ? `: ${reason}` : ""}`);
  error.name = "AbortError";
  return error;
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
