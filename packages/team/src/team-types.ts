/**
 * Public types for `@walle-agent/team`.
 *
 * Top-level orchestration primitives (TeamMember / TeamConfig / TeamRunOptions)
 * plus Swarm types. The Blackboard class lives in its own module; we import
 * it as a type here so callers don't have to know about that file.
 */

import type { Agent, AgentResult } from "@walle-agent/core";
import type { Blackboard } from "./blackboard.js";

// ─── AgentTeam ─────────────────────────────────────────────────────

export interface TeamMember {
  /** Unique label inside the team (used by `pipelineOrder`, supervisor prompts, debate transcripts). */
  name: string;
  /** The Agent instance to delegate to. */
  agent: Agent;
  /** Free-text role description, surfaced to the agent on every turn. */
  role: string;
  /** Optional longer description, surfaced in supervisor prompts. */
  description?: string;
}

export interface TeamConfig {
  members: TeamMember[];
  /**
   * Optional pre-built coordinator Agent. Required for `strategy: "supervisor"`.
   * For supervisor mode, this Agent must already carry the delegate tools —
   * use `createSupervisorTeam(...)` for the convenient build path.
   */
  coordinator?: Agent;
}

export interface TeamRunOptions {
  /** Orchestration strategy. */
  strategy: "supervisor" | "pipeline" | "parallel" | "debate";
  /** Round cap for `debate`. Defaults to 3. */
  maxRounds?: number;
  /** Override member execution order for `pipeline`. Defaults to `members[]` order. */
  pipelineOrder?: string[];
}

// ─── Swarm ─────────────────────────────────────────────────────────

export interface SwarmRound {
  index: number;
  agents: string[];
  outputs: AgentResult[];
}

export interface SwarmState {
  task: string;
  rounds: SwarmRound[];
  blackboard: Blackboard;
}

export interface SwarmPolicy {
  /** Pick which members participate in this round. Returning `[]` ends the run. */
  selectAgents(task: string, state: SwarmState, members: TeamMember[]): Promise<TeamMember[]>;

  /** Decide whether another round should run. Called before each iteration. */
  shouldContinue(state: SwarmState): Promise<boolean>;

  /** Optional final-content synthesizer. Defaults to `blackboard.renderFinal()`. */
  synthesize?(state: SwarmState): Promise<string>;
}

// ─── Coordinator (interface; not implemented in MVP) ──────────────

export interface CoordinateParams {
  task: string;
  members: TeamMember[];
  maxRounds: number;
  blackboard?: Blackboard;
}

/**
 * Pluggable coordinator interface. Reserved for future implementations that
 * want to define their own coordination semantics outside `AgentTeam`/`Swarm`.
 * Not consumed by the current strategies — they delegate to the coordinator
 * Agent on `TeamConfig.coordinator` directly.
 */
export interface Coordinator {
  coordinate(params: CoordinateParams): Promise<AgentResult>;
}
