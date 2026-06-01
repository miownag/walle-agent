/**
 * @walle-agent/team — public API.
 *
 * Top-level orchestration primitives for multi-Agent collaboration. Not a
 * `WallePlugin` — users instantiate AgentTeam / Swarm / Blackboard directly.
 */

export { AgentTeam } from "./agent-team.js";
export { Swarm } from "./swarm.js";
export { Blackboard } from "./blackboard.js";
export type { BlackboardEntry } from "./blackboard.js";

export { createSubAgentTool, slugifyToolName } from "./sub-agent-tool.js";
export type {
  SubAgentToolInput,
  SubAgentToolOutput,
  SubAgentToolOptions,
} from "./sub-agent-tool.js";

export { createSupervisorTeam } from "./create-supervisor.js";
export type { SupervisorTeamOptions } from "./create-supervisor.js";

export { SubAgentsPlugin } from "./sub-agents-plugin.js";
export type { SubAgentsPluginOptions } from "./sub-agents-plugin.js";

export type {
  TeamMember,
  TeamConfig,
  TeamRunOptions,
  SwarmPolicy,
  SwarmState,
  SwarmRound,
  Coordinator,
  CoordinateParams,
} from "./team-types.js";
