/**
 * TokenBudget — basic context window management.
 */

import type { TokenBudgetConfig } from "./agent-config.js";
import type { ContextItem } from "./events.js";
import { estimateStringTokens } from "./token-estimate.js";

export interface BudgetAllocation {
  items: ContextItem[];
  totalTokens: number;
  trimmed: number;
}

export class TokenBudget {
  readonly maxContextTokens: number;
  readonly systemReserve: number;
  readonly completionReserve: number;

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
      const estimated = item.estimatedTokens ?? estimateStringTokens(item.content);

      if (totalTokens + estimated <= availableTokens) {
        included.push(item);
        totalTokens += estimated;
      } else {
        trimmed++;
      }
    }

    return { items: included, totalTokens, trimmed };
  }
}
