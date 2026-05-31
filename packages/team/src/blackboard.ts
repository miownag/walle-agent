/**
 * Blackboard — append-only shared state for Swarm coordination.
 *
 * Each entry is timestamped on `post()`. `renderForAgent()` builds the prompt
 * surface every member sees on its turn; `renderFinal()` is the default fallback
 * for `Swarm.run()` when no `policy.synthesize` is provided.
 */

export interface BlackboardEntry {
  agent: string;
  content: string;
  round: number;
  timestamp: string;
}

export class Blackboard {
  private entries: BlackboardEntry[] = [];

  /**
   * Append an entry. Async-shaped for future persistent backends; the in-memory
   * implementation never awaits anything.
   */
  async post(entry: Omit<BlackboardEntry, "timestamp">): Promise<void> {
    this.entries.push({
      ...entry,
      timestamp: new Date().toISOString(),
    });
  }

  /** Defensive copy; callers must not mutate the live list. */
  getEntries(): BlackboardEntry[] {
    return [...this.entries];
  }

  /** Render the next-turn prompt: original task + history + a "Your Turn" anchor. */
  renderForAgent(task: string): string {
    if (this.entries.length === 0) return task;

    const history = this.entries
      .map((e) => `[${e.agent} @ Round ${e.round}]: ${e.content}`)
      .join("\n\n");

    return `Task: ${task}\n\n## Previous Discussion:\n\n${history}\n\n## Your Turn:`;
  }

  /** Default synthesis: every entry concatenated with a section divider. */
  renderFinal(): string {
    return this.entries
      .map((e) => `## ${e.agent}\n${e.content}`)
      .join("\n\n---\n\n");
  }
}
