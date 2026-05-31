/**
 * TokenBudget — basic context window management.
 */

import type { TokenBudgetConfig } from "./agent-config.js";
import type { ContextItem } from "./events.js";

export interface BudgetAllocation {
  items: ContextItem[];
  totalTokens: number;
  trimmed: number;
}

export class TokenBudget {
  private maxContextTokens: number;
  private systemReserve: number;
  private completionReserve: number;

  constructor(config: TokenBudgetConfig) {
    this.maxContextTokens = config.maxContextTokens ?? 128_000;
    this.systemReserve = config.systemReserve ?? 2000;
    this.completionReserve = config.completionReserve ?? 4096;
  }

  /**
   * Allocate context items within token budget.
   * Sort by priority (descending), include as many as budget allows.
   */
  allocate(items: ContextItem[]): BudgetAllocation {
    const availableTokens = this.maxContextTokens - this.systemReserve - this.completionReserve;

    // Sort by priority descending
    const sorted = [...items].sort((a, b) => b.priority - a.priority);

    const included: ContextItem[] = [];
    let totalTokens = 0;
    let trimmed = 0;

    for (const item of sorted) {
      const estimated = item.estimatedTokens ?? this.estimateTokens(item.content);

      if (totalTokens + estimated <= availableTokens) {
        included.push(item);
        totalTokens += estimated;
      } else {
        trimmed++;
      }
    }

    return { items: included, totalTokens, trimmed };
  }

  /**
   * Simple token estimation (rough: 1 token ≈ 4 chars for English, 2 chars for CJK).
   */
  private estimateTokens(content: string): number {
    // Simple heuristic: count chars / 3 (works reasonably for mixed content)
    return Math.ceil(content.length / 3);
  }
}
