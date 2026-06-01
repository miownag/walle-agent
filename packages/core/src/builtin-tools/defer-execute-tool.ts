/**
 * `defer_execute_tool` — built-in tool factory for the dynamic
 * tool-search / defer-execute mechanism. See `docs/22-tool-search.md`.
 *
 * Looks up a registered (typically shadowed) tool by qualifiedName and
 * delegates to its `execute(...)`, going through the standard permission
 * policy as if the LLM had invoked it directly.
 */

import { defineTool } from "../tool.js";
import type { Tool, ToolExecutionContext } from "../tool.js";
import type { ToolRegistry } from "../tool-registry.js";
import type { PermissionDecision } from "../permissions.js";
import type { ModelToolCall } from "../message.js";
import type { EventBus } from "../events.js";
import { TOOL_SEARCH_NAME, DEFER_EXECUTE_NAME } from "./tool-search.js";

export { DEFER_EXECUTE_NAME };

export interface DeferExecuteInput {
  qualifiedName: string;
  arguments?: Record<string, unknown>;
}

export type DeferExecuteOutput = unknown; // forwarded from underlying tool

export interface DeferExecuteErrorOutput {
  error: string;
  qualifiedName?: string;
  reason?: string;
  hint?: string;
}

export type CheckPermissionFn = (
  tool: Tool,
  call: ModelToolCall,
) => Promise<PermissionDecision> | PermissionDecision;

export interface CreateDeferExecuteOptions {
  registry: ToolRegistry;
  /**
   * Permission gate. Runtime injects a function bound to the agent's
   * `PermissionPolicy`; tests / standalone callers can pass `() => ({ allowed: true })`.
   */
  checkPermission: CheckPermissionFn;
}

interface AgentWithEventBus {
  getEventBus?(): EventBus | undefined;
}

export function createDeferExecuteTool(
  opts: CreateDeferExecuteOptions,
): Tool<DeferExecuteInput, DeferExecuteOutput | DeferExecuteErrorOutput> {
  const { registry, checkPermission } = opts;
  return defineTool<DeferExecuteInput, DeferExecuteOutput | DeferExecuteErrorOutput>({
    name: DEFER_EXECUTE_NAME,
    description:
      "Execute a tool that is currently hidden from your tool list. " +
      "First call tool_search to find the tool, then call this with its " +
      "qualifiedName and arguments. The tool's permission policy still applies.",
    parameters: {
      type: "object",
      properties: {
        qualifiedName: {
          type: "string",
          description: "qualifiedName from tool_search.matches[i].qualifiedName.",
        },
        arguments: {
          type: "object",
          description: "Arguments forwarded to the underlying tool.",
        },
      },
      required: ["qualifiedName", "arguments"],
    },
    riskLevel: "low",
    tags: ["builtin"],

    async execute(input, ctx: ToolExecutionContext) {
      if (!input || typeof input.qualifiedName !== "string" || !input.qualifiedName) {
        return { error: "defer_execute_tool: 'qualifiedName' is required" };
      }
      if (
        input.qualifiedName === DEFER_EXECUTE_NAME ||
        input.qualifiedName === TOOL_SEARCH_NAME
      ) {
        return { error: "cannot defer-execute tool_search/defer_execute_tool" };
      }
      const tool = registry.get(input.qualifiedName);
      if (!tool) {
        return {
          error: "tool not found",
          qualifiedName: input.qualifiedName,
          hint: "Use tool_search to discover available tools.",
        };
      }

      const args = (input.arguments ?? {}) as Record<string, unknown>;
      const callId = `defer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const synthCall: ModelToolCall = {
        id: callId,
        name: tool.name,
        arguments: args,
      };

      let decision: PermissionDecision;
      try {
        decision = await checkPermission(tool, synthCall);
      } catch (err) {
        return { error: `permission check threw: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (!decision.allowed) {
        const events = (ctx.agent as unknown as AgentWithEventBus).getEventBus?.();
        if (events) {
          await events.emit("tool_defer_executed", {
            qualifiedName: input.qualifiedName,
            status: "denied",
            durationMs: 0,
          });
        }
        return { error: "permission denied", reason: decision.reason };
      }

      const start = Date.now();
      try {
        const out = await tool.execute(args, ctx);
        const events = (ctx.agent as unknown as AgentWithEventBus).getEventBus?.();
        if (events) {
          await events.emit("tool_defer_executed", {
            qualifiedName: input.qualifiedName,
            status: "success",
            durationMs: Date.now() - start,
          });
        }
        return out as DeferExecuteOutput;
      } catch (err) {
        const events = (ctx.agent as unknown as AgentWithEventBus).getEventBus?.();
        if (events) {
          await events.emit("tool_defer_executed", {
            qualifiedName: input.qualifiedName,
            status: "error",
            durationMs: Date.now() - start,
          });
        }
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}
