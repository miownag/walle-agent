/**
 * createSubAgentTool — wrap an Agent as a Tool so other Agents can delegate
 * sub-tasks to it via function calling.
 *
 * **Spec deviation (intentional)**: spec uses `delegate_${agent.name}` raw,
 * but OpenAI/Anthropic both reject tool names outside `^[a-zA-Z0-9_-]+$`
 * server-side. We slugify the agent name. Pass `options.name` to override.
 */

import type { Agent, Tool } from "@walle-agent/core";
import { defineTool } from "@walle-agent/core";

export interface SubAgentToolInput {
  task: string;
}

export interface SubAgentToolOutput {
  result: string;
}

export interface SubAgentToolOptions {
  /** Override the auto-generated `delegate_<slug>` name. */
  name?: string;
  /** Override the default description. */
  description?: string;
  /** Reserved for future per-call output budgeting. Currently unused. */
  maxTokens?: number;
}

/**
 * Best-effort slugifier. Lowercases, collapses non-alphanumerics to `_`,
 * trims edge underscores, caps to 60 chars, falls back to `"agent"` for
 * empty results.
 */
export function slugifyToolName(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return slug.length > 0 ? slug : "agent";
}

export function createSubAgentTool(
  agent: Agent,
  options: SubAgentToolOptions = {},
): Tool<SubAgentToolInput, SubAgentToolOutput> {
  const slug = slugifyToolName(agent.name);
  const name = options.name ?? `delegate_${slug}`;
  const description =
    options.description ?? `Delegate a task to ${agent.name}. Returns the sub-agent's final answer.`;

  return defineTool<SubAgentToolInput, SubAgentToolOutput>({
    name,
    description,
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Task description for the sub-agent",
        },
      },
      required: ["task"],
    },
    riskLevel: "low",
    tags: ["sub-agent"],
    async execute(input) {
      const result = await agent.run(input.task);
      return { result: result.content };
    },
  });
}
