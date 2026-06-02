/**
 * Built-in `task` tool — dynamic sub-agent dispatch.
 *
 * Aligns with Claude Code's `Task` tool: a single generic tool whose
 * `subagent_type` argument selects a pre-registered SubAgentDefinition.
 * Each invocation creates a fresh sub-agent, runs the prompt to completion,
 * disposes the sub-agent, and returns its final content.
 *
 * Unlike the other built-ins, this tool is NOT a module-level singleton —
 * its description must enumerate the registry's currently-known types so
 * the parent LLM knows what to pick. `AgentRuntime` builds a per-agent
 * instance via `createTaskTool({ registry, defaultModel })`.
 *
 * See:
 *   - docs/14-team-swarm.md#dynamic-subagenttask-工具
 *   - docs/20-builtin-tools.md#task
 */

import { z } from "zod";
import { defineTool } from "../tool.js";
import type { Tool } from "../tool.js";
import type { LLMProvider } from "../llm-provider.js";
import type { SubAgentRegistry, SubAgentDefinition } from "../sub-agent-registry.js";
import type { ModelMessage } from "../message.js";
import type { ToolCallRecord } from "../tool.js";

/**
 * Reserved name for the built-in task tool. Exported so other modules
 * (registerBuiltinTools, exclude/include filtering) can refer to a single
 * source of truth.
 */
export const TASK_TOOL_NAME = "task";

// ─── Input / Output ────────────────────────────────────────────────

export interface TaskToolInput {
  subagent_type: string;
  description: string;
  prompt: string;
}

export interface TaskToolSuccessOutput {
  result: string;
  /** Present only when the SubAgentDefinition has `verbose: true`. */
  messages?: ModelMessage[];
  /** Present only when the SubAgentDefinition has `verbose: true`. */
  toolCalls?: ToolCallRecord[];
}

export interface TaskToolErrorOutput {
  error: string;
  available?: string[];
}

export type TaskToolOutput = TaskToolSuccessOutput | TaskToolErrorOutput;

// ─── Factory Options ───────────────────────────────────────────────

export interface CreateTaskToolOptions {
  registry: SubAgentRegistry;
  /**
   * Fallback model used when a `SubAgentDefinition` does not specify
   * `model`. Typically the parent Agent's model. If unset and a definition
   * also has no `model`, the task call returns an error output.
   */
  defaultModel?: LLMProvider;
  /**
   * Optional fallback `maxTurns` used when neither the SubAgentDefinition
   * nor the parent Agent specifies one. Forwarded into `Agent.create`.
   */
  defaultMaxTurns?: number;
  /**
   * Override the tool name. Defaults to "task". Mostly useful when an
   * advanced user wants to ship a second task tool alongside the built-in.
   */
  name?: string;
  /**
   * Override the tool description. The auto-generated default lists known
   * `subagent_type` values so the parent LLM can pick one.
   */
  description?: string;
}

// ─── createTaskTool ────────────────────────────────────────────────

/**
 * Build a task tool bound to the given registry. Should be called once per
 * Agent at construction time.
 *
 * The Agent class is imported lazily inside `execute()` to break the
 * tool ↔ agent ↔ tool circular dependency at module load.
 */
export function createTaskTool(opts: CreateTaskToolOptions): Tool<TaskToolInput, TaskToolOutput> {
  const { registry, defaultModel, defaultMaxTurns } = opts;

  const buildDescription = (): string => {
    if (opts.description) return opts.description;
    const types = registry.types();
    const typeList = types.length > 0 ? types.join(", ") : "(none registered)";
    return [
      "Dispatch a sub-task to a registered sub-agent.",
      `Use this when a specialised, isolated sub-agent should handle a self-contained task.`,
      `Available sub-agent types: ${typeList}.`,
      "The sub-agent runs to completion in a fresh context and only its final summary is returned.",
    ].join(" ");
  };

  const typeEnumDescription = (): string => {
    const types = registry.list();
    if (types.length === 0) return "Type of sub-agent to dispatch. (No types registered.)";
    const lines = types.map((d) =>
      d.description ? `  - "${d.type}": ${d.description}` : `  - "${d.type}"`,
    );
    return [
      "Type of sub-agent to dispatch. Must be one of the registered types:",
      ...lines,
    ].join("\n");
  };

  return defineTool(
    opts.name ?? TASK_TOOL_NAME,
    buildDescription(),
    {
      subagent_type: z.string().describe(typeEnumDescription()),
      description: z
        .string()
        .describe("Short (3-5 word) summary of the sub-task. Surfaced to the user / UI."),
      prompt: z.string().describe("The actual task prompt sent to the sub-agent."),
    },
    async (input, ctx): Promise<TaskToolOutput> => {
      // Validate input shape defensively — LLM tool calls are best-effort.
      if (!input || typeof input.subagent_type !== "string") {
        return { error: "task: missing required field 'subagent_type'" };
      }
      if (typeof input.prompt !== "string" || input.prompt.length === 0) {
        return { error: "task: 'prompt' must be a non-empty string" };
      }

      const def: SubAgentDefinition | undefined = registry.get(input.subagent_type);
      if (!def) {
        return {
          error: `task: unknown subagent_type "${input.subagent_type}"`,
          available: registry.types(),
        };
      }

      const model = def.model ?? defaultModel;
      if (!model) {
        return {
          error:
            `task: no model available for subagent_type "${def.type}" — ` +
            "neither SubAgentDefinition.model nor createTaskTool({ defaultModel }) is set.",
        };
      }

      // Lazy import to avoid the tool-tool.ts ⇄ agent.ts circular dep at module load.
      const { Agent } = await import("../agent.js");

      const child = await Agent.create({
        name: `${ctx.agent.name}/${def.type}`,
        model,
        systemPrompt: def.systemPrompt,
        tools: def.tools ?? [],
        // Default false to prevent accidental task-tool recursion. A def can
        // explicitly opt back in via `useBuiltinTools: { includeTools: [...] }`.
        useBuiltinTools: def.useBuiltinTools ?? false,
        plugins: def.plugins,
        maxTurns: def.maxTurns ?? defaultMaxTurns,
        sessionId: def.inheritSession ? ctx.agent.sessionId : undefined,
      });

      try {
        const result = await child.run(input.prompt, { signal: ctx.signal });
        if (def.verbose) {
          return {
            result: result.content,
            messages: result.messages,
            toolCalls: result.toolCalls,
          };
        }
        return { result: result.content };
      } finally {
        // Always dispose so the sub-agent's plugins (memory, mcp, …) release
        // their resources, even if the run threw.
        try {
          await child.dispose();
        } catch {
          // Swallow dispose errors so they don't mask the original outcome.
        }
      }
    },
    {
      riskLevel: "low",
      tags: ["builtin", "sub-agent"],
      annotations: { openWorldHint: false },
    },
  );
}
