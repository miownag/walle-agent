/**
 * `read_tool_result` — built-in tool that pages back into the on-disk
 * eviction vault for tool results that have been turned into placeholders
 * by micro compression (see `docs/21-context-compression.md`).
 *
 * Implementation strategy: the tool emits a `vault_read` event on the
 * agent's EventBus. A backend (typically `MemoryPlugin`) listens, calls
 * `vault.readSlice(...)`, and writes the result into `payload.result.value`.
 * If no backend writes anything, the tool reports the vault as unavailable.
 *
 * This indirection lets `core` stay zero-dep — the actual filesystem read
 * lives in `@walle-agent/memory`.
 */

import { defineTool } from "../tool.js";
import type { Tool } from "../tool.js";
import type { EventBus } from "../events.js";

export const READ_TOOL_RESULT_NAME = "read_tool_result";

export interface ReadToolResultInput {
  toolCallId: string;
  offset?: number;
  limit?: number;
}

export interface ReadToolResultOutput {
  content: string;
  totalLines: number;
  truncated: boolean;
}

export interface ReadToolResultErrorOutput {
  error: string;
}

interface AgentWithEventBus {
  getEventBus?(): EventBus | undefined;
}

export const readToolResultTool: Tool<
  ReadToolResultInput,
  ReadToolResultOutput | ReadToolResultErrorOutput
> = defineTool<ReadToolResultInput, ReadToolResultOutput | ReadToolResultErrorOutput>({
  name: READ_TOOL_RESULT_NAME,
  description:
    "Read the full content of an evicted tool result by its toolCallId. " +
    "When older tool outputs in your conversation are replaced by " +
    "[ToolResult #N evicted | toolCallId=...] placeholders, use this tool " +
    "to load the original content. Supports offset/limit for paginating " +
    "very large outputs (line-based).",
  parameters: {
    type: "object",
    properties: {
      toolCallId: {
        type: "string",
        description: "The toolCallId from the placeholder header.",
      },
      offset: {
        type: "number",
        description: "0-based line offset into the stored content. Default 0.",
      },
      limit: {
        type: "number",
        description: "Maximum number of lines to return. Default 200.",
      },
    },
    required: ["toolCallId"],
  },
  riskLevel: "low",
  tags: ["builtin"],

  async execute(input, ctx) {
    if (!input || typeof input.toolCallId !== "string" || input.toolCallId.length === 0) {
      return { error: "read_tool_result: 'toolCallId' is required" };
    }
    const events = (ctx.agent as unknown as AgentWithEventBus).getEventBus?.();
    if (!events) {
      return {
        error:
          "read_tool_result: agent does not expose an EventBus — install @walle-agent/memory.",
      };
    }
    const result: { value?: ReadToolResultOutput | ReadToolResultErrorOutput } = {};
    await events.emit("vault_read", {
      toolCallId: input.toolCallId,
      offset: typeof input.offset === "number" ? Math.max(0, input.offset) : 0,
      limit: typeof input.limit === "number" ? Math.max(1, input.limit) : 200,
      result,
    });
    if (!result.value) {
      return {
        error:
          "read_tool_result: tool result vault not available — install @walle-agent/memory.",
      };
    }
    return result.value;
  },
});
