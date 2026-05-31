/**
 * Swarm — dynamic multi-agent orchestrator driven by a `SwarmPolicy`.
 *
 * Each round:
 *   1. `policy.shouldContinue(state)` decides whether to keep going.
 *   2. `policy.selectAgents(task, state, members)` picks who participates.
 *   3. Selected members run concurrently with `blackboard.renderForAgent(task)`.
 *   4. Each output is posted to the blackboard.
 *
 * Final content comes from `policy.synthesize(state)` if provided, else from
 * `blackboard.renderFinal()`.
 *
 * Safety guards beyond spec: an empty `selectAgents` result breaks the loop
 * (avoids infinite zero-work iterations).
 */

import type { AgentResult } from "@walle-agent/core";
import { Blackboard } from "./blackboard.js";
import type {
  SwarmPolicy,
  SwarmRound,
  SwarmState,
  TeamMember,
} from "./team-types.js";

export class Swarm {
  constructor(
    private readonly members: TeamMember[],
    private readonly policy: SwarmPolicy,
    private readonly blackboard: Blackboard = new Blackboard(),
  ) {
    if (!members || members.length === 0) {
      throw new Error("Swarm: members must contain at least one TeamMember");
    }
  }

  /** Read access to the blackboard (mostly for inspection/tests). */
  getBlackboard(): Blackboard {
    return this.blackboard;
  }

  async run(task: string): Promise<AgentResult> {
    const state: SwarmState = {
      task,
      rounds: [],
      blackboard: this.blackboard,
    };

    while (await this.policy.shouldContinue(state)) {
      const selected = await this.policy.selectAgents(task, state, this.members);
      if (selected.length === 0) break;

      const prompt = this.blackboard.renderForAgent(task);
      const outputs = await Promise.all(selected.map((m) => m.agent.run(prompt)));

      const round: SwarmRound = {
        index: state.rounds.length,
        agents: selected.map((s) => s.name),
        outputs,
      };
      state.rounds.push(round);

      for (let i = 0; i < outputs.length; i++) {
        await this.blackboard.post({
          agent: selected[i].name,
          content: outputs[i].content,
          round: round.index,
        });
      }
    }

    const finalContent = this.policy.synthesize
      ? await this.policy.synthesize(state)
      : this.blackboard.renderFinal();

    return {
      content: finalContent,
      messages: state.rounds.flatMap((r) => r.outputs.flatMap((o) => o.messages)),
      toolCalls: state.rounds.flatMap((r) => r.outputs.flatMap((o) => o.toolCalls)),
      events: state.rounds.flatMap((r) => r.outputs.flatMap((o) => o.events)),
    };
  }
}
