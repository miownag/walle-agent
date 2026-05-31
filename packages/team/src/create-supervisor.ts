/**
 * createSupervisorTeam — convenience builder for `strategy: "supervisor"`.
 *
 * Wires `createSubAgentTool` for every member into a fresh coordinator
 * Agent. Replaces the spec's `(coordinator as any).runtime.config.model`
 * reach-through with build-time tool registration.
 *
 * Usage:
 *
 * ```ts
 * const team = await createSupervisorTeam({
 *   members: [{ name: "Researcher", agent: r, role: "Research" }, ...],
 *   coordinator: { model: openai },
 * });
 * await team.run("…", { strategy: "supervisor" });
 * ```
 */

import { Agent } from "@walle-agent/core";
import type { LLMProvider, WallePlugin } from "@walle-agent/core";
import { AgentTeam } from "./agent-team.js";
import { createSubAgentTool } from "./sub-agent-tool.js";
import type { TeamMember } from "./team-types.js";

export interface SupervisorTeamOptions {
  members: TeamMember[];
  coordinator: {
    /** Defaults to `"Supervisor"`. */
    name?: string;
    /** LLMProvider for the coordinator Agent. Required. */
    model: LLMProvider;
    /** Override the auto-generated systemPrompt. */
    systemPrompt?: string;
    /** Forwarded to `Agent.create` (e.g. memory plugins). */
    plugins?: WallePlugin[];
  };
}

export async function createSupervisorTeam(opts: SupervisorTeamOptions): Promise<AgentTeam> {
  if (!opts.members || opts.members.length === 0) {
    throw new Error("createSupervisorTeam: at least one member is required");
  }

  const delegateTools = opts.members.map((m) =>
    createSubAgentTool(m.agent, {
      description: `Delegate a sub-task to ${m.name} (${m.role})${
        m.description ? ` — ${m.description}` : ""
      }.`,
    }),
  );

  const defaultPrompt = [
    "You are a task coordinator. Break down the user task and delegate sub-tasks to team members.",
    "",
    "Available team members:",
    ...opts.members.map(
      (m) => `- ${m.name}: ${m.role}${m.description ? ` — ${m.description}` : ""}`,
    ),
    "",
    "Use the delegate_* tools to assign sub-tasks. Synthesize the results into a final answer.",
  ].join("\n");

  const coordinator = await Agent.create({
    name: opts.coordinator.name ?? "Supervisor",
    model: opts.coordinator.model,
    systemPrompt: opts.coordinator.systemPrompt ?? defaultPrompt,
    tools: delegateTools,
    plugins: opts.coordinator.plugins,
  });

  return new AgentTeam({ members: opts.members, coordinator });
}
