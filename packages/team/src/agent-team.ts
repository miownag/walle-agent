/**
 * AgentTeam — fixed-role multi-agent orchestrator.
 *
 * Strategies:
 * - **parallel**: every member runs the task concurrently; outputs concatenated.
 * - **pipeline**: members run in order; each consumes the prior member's content.
 * - **debate**: every member responds to the running transcript for `maxRounds`
 *   rounds; optional coordinator summarises at the end.
 * - **supervisor**: delegates the task to `config.coordinator` (which must
 *   already carry delegate tools — use `createSupervisorTeam` for the build path).
 *
 * All strategies merge per-call `messages` / `toolCalls` / `events` into the
 * returned AgentResult so downstream consumers (memory, trace) see the
 * full picture.
 */

import type { AgentResult } from "@walle-agent/core";
import type { TeamConfig, TeamMember, TeamRunOptions } from "./team-types.js";

export class AgentTeam {
  constructor(private readonly config: TeamConfig) {
    if (!config.members || config.members.length === 0) {
      throw new Error("AgentTeam: TeamConfig.members must contain at least one member");
    }
  }

  /** Returns the team config (read-only access for callers/tests). */
  get members(): readonly TeamMember[] {
    return this.config.members;
  }

  async run(task: string, options: TeamRunOptions): Promise<AgentResult> {
    switch (options.strategy) {
      case "parallel":
        return this.runParallel(task);
      case "pipeline":
        return this.runPipeline(task, options);
      case "debate":
        return this.runDebate(task, options);
      case "supervisor":
        return this.runSupervisor(task);
      default: {
        const exhaustive: never = options.strategy as never;
        throw new Error(`AgentTeam.run: unknown strategy ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  // ─── parallel ───────────────────────────────────────────────────

  private async runParallel(task: string): Promise<AgentResult> {
    const results = await Promise.all(
      this.config.members.map((m) =>
        m.agent.run(`[Your Role: ${m.role}]\n\nTask: ${task}`),
      ),
    );
    return mergeResults(this.config.members, results);
  }

  // ─── pipeline ───────────────────────────────────────────────────

  private async runPipeline(task: string, options: TeamRunOptions): Promise<AgentResult> {
    const order = options.pipelineOrder ?? this.config.members.map((m) => m.name);
    const ordered = order.map((name) => {
      const m = this.config.members.find((x) => x.name === name);
      if (!m) {
        throw new Error(`AgentTeam.runPipeline: pipelineOrder references unknown member "${name}"`);
      }
      return m;
    });

    let currentInput = task;
    const allResults: AgentResult[] = [];

    for (const member of ordered) {
      const prompt = [
        `[Your Role: ${member.role}]`,
        ``,
        `Previous stage output:`,
        currentInput,
        ``,
        `Your task: Process the above and produce your output.`,
      ].join("\n");

      const result = await member.agent.run(prompt);
      allResults.push(result);
      currentInput = result.content;
    }

    return {
      content: currentInput,
      messages: allResults.flatMap((r) => r.messages),
      toolCalls: allResults.flatMap((r) => r.toolCalls),
      events: allResults.flatMap((r) => r.events),
    };
  }

  // ─── debate ─────────────────────────────────────────────────────

  private async runDebate(task: string, options: TeamRunOptions): Promise<AgentResult> {
    const maxRounds = options.maxRounds ?? 3;
    const allResults: AgentResult[] = [];
    let context = `Task: ${task}\n\n`;

    for (let round = 0; round < maxRounds; round++) {
      const roundResults = await Promise.all(
        this.config.members.map((m) =>
          m.agent.run(
            [
              `[Your Role: ${m.role}]`,
              `[Round ${round + 1}/${maxRounds}]`,
              ``,
              context,
              ``,
              `Provide your analysis. If this is not the first round, respond to other members' points.`,
            ].join("\n"),
          ),
        ),
      );
      allResults.push(...roundResults);

      context += `\n## Round ${round + 1}\n\n`;
      for (let i = 0; i < roundResults.length; i++) {
        context += `### ${this.config.members[i].name}: ${roundResults[i].content}\n\n`;
      }
    }

    if (this.config.coordinator) {
      const summary = await this.config.coordinator.run(
        `Summarize the debate and provide a final decision:\n\n${context}`,
      );
      return {
        content: summary.content,
        messages: [...allResults.flatMap((r) => r.messages), ...summary.messages],
        toolCalls: [...allResults.flatMap((r) => r.toolCalls), ...summary.toolCalls],
        events: [...allResults.flatMap((r) => r.events), ...summary.events],
      };
    }

    return {
      content: context,
      messages: allResults.flatMap((r) => r.messages),
      toolCalls: allResults.flatMap((r) => r.toolCalls),
      events: allResults.flatMap((r) => r.events),
    };
  }

  // ─── supervisor ─────────────────────────────────────────────────

  private async runSupervisor(task: string): Promise<AgentResult> {
    if (!this.config.coordinator) {
      throw new Error(
        'AgentTeam.runSupervisor: supervisor strategy requires a coordinator agent in TeamConfig. ' +
          "Use createSupervisorTeam() to build one with delegate tools wired in.",
      );
    }
    return this.config.coordinator.run(task);
  }
}

// ─── helpers ──────────────────────────────────────────────────────

function mergeResults(members: readonly TeamMember[], results: AgentResult[]): AgentResult {
  const content = results
    .map((r, i) => `## ${members[i].name} (${members[i].role})\n\n${r.content}`)
    .join("\n\n---\n\n");
  return {
    content,
    messages: results.flatMap((r) => r.messages),
    toolCalls: results.flatMap((r) => r.toolCalls),
    events: results.flatMap((r) => r.events),
  };
}
