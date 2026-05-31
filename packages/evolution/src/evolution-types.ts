/**
 * Evolution types — proposals, reasons, config.
 */

import type { LLMProvider, ModelMessage } from "@walle-agent/core";
import type { MemoryManager, MemoryScope, MemoryType } from "@walle-agent/memory";
import type { SkillRegistry } from "@walle-agent/skills";

// ─── Reasons ─────────────────────────────────────────────────────────

export type EvolutionReason =
  | "explicit_remember"
  | "periodic_review"
  | "task_review";

// ─── Proposals ───────────────────────────────────────────────────────

export interface MemoryProposal {
  type: MemoryType;
  content: string;
  /** 0..1 */
  importance: number;
  /** 0..1 */
  confidence: number;
  scope: MemoryScope;
  tags?: string[];
}

export interface SkillProposal {
  name: string;
  description: string;
  /** Step-by-step reusable procedure. */
  content: string;
  tags?: string[];
  /** 0..1 */
  confidence: number;
  triggerExamples?: string[];
  triggerKeywords?: string[];
}

export type EvolutionProposalPayload = MemoryProposal | SkillProposal;

export interface EvolutionProposal {
  id?: string;
  type: "memory" | "skill";
  payload: EvolutionProposalPayload;
  reason: EvolutionReason;
  /** Links this proposal back to the run that produced it (useful for auditing). */
  runId?: string;
  sessionId?: string;
  createdAt?: string;
  status?: "pending" | "approved" | "rejected" | "applied";
  /** Free-form reviewer note on approve/reject. */
  note?: string;
}

// ─── Engine context / callbacks ─────────────────────────────────────

export interface EvolutionContext {
  /** Monotonic counter over `runs` observed since plugin install. */
  turnCounter: number;
  runId: string;
  sessionId?: string;
  messages: ModelMessage[];
}

export interface ProposalStore {
  enqueue(proposal: EvolutionProposal): Promise<EvolutionProposal>;
  list(filter?: { status?: EvolutionProposal["status"] }): Promise<EvolutionProposal[]>;
  get(id: string): Promise<EvolutionProposal | undefined>;
  approve(id: string, note?: string): Promise<EvolutionProposal | undefined>;
  reject(id: string, note?: string): Promise<EvolutionProposal | undefined>;
  markApplied(id: string): Promise<void>;
  delete(id: string): Promise<void>;
}

// ─── Plugin config ──────────────────────────────────────────────────

export interface ExplicitRememberConfig {
  /** Default: true. */
  enabled?: boolean;
  /** Override default trigger patterns. */
  patterns?: RegExp[];
}

export interface PeriodicReviewConfig {
  /** Default: false. */
  enabled?: boolean;
  /** Fire every N runs. Default: 10. */
  everyTurns?: number;
  /** Max messages passed to the reviewer LLM. Default: 20. */
  maxMessagesInReview?: number;
}

export interface TaskReviewConfig {
  /** Default: false. */
  enabled?: boolean;
  /** Minimum tool-call count in a run for it to qualify as a "task". Default: 5. */
  minToolCalls?: number;
  /** Minimum successful tool-call count. Default: `minToolCalls`. */
  minSuccessfulToolCalls?: number;
  /** Max messages passed to the reviewer LLM. Default: 30. */
  maxMessagesInReview?: number;
}

export interface MemoryCreationConfig {
  /** Default: true. */
  enabled?: boolean;
  /** Default: false — auto-apply without human review. */
  requireApproval?: boolean;
  /** Reject proposals below this importance. Default: 0.5. */
  minImportance?: number;
  /** Reject proposals below this confidence. Default: 0.5. */
  minConfidence?: number;
}

export interface SkillCreationConfig {
  /** Default: true. */
  enabled?: boolean;
  /** Default: true — skills are riskier, require review by default. */
  requireApproval?: boolean;
  /** Reject proposals below this confidence. Default: 0.7. */
  minConfidence?: number;
}

export interface EvolutionPluginConfig {
  /** Root directory for evolution state. Default: `./.walle/evolution`. */
  rootDir?: string;
  /** Override proposal queue directory. Default: `<rootDir>/proposals`. */
  proposalStorePath?: string;

  /** Override the LLM used for reviews. Defaults to the agent's configured model. */
  reviewModel?: LLMProvider;

  explicitRemember?: ExplicitRememberConfig;
  periodicReview?: PeriodicReviewConfig;
  taskReview?: TaskReviewConfig;
  memoryCreation?: MemoryCreationConfig;
  skillCreation?: SkillCreationConfig;

  /**
   * Optional sync approval callback. Returning `true` applies the proposal,
   * `false` rejects it. If absent, unapproved proposals go to the file queue.
   */
  approvalHandler?: (proposal: EvolutionProposal) => Promise<boolean> | boolean;

  /**
   * Fired whenever a proposal is generated — before approval/apply. Useful
   * for UI integration or logging.
   */
  onProposal?: (proposal: EvolutionProposal) => Promise<void> | void;
}

// ─── Engine deps ────────────────────────────────────────────────────

export interface EvolutionEngineDeps {
  config: EvolutionPluginConfig;
  model: LLMProvider;
  memory: MemoryManager;
  skills?: SkillRegistry;
  proposalStore: ProposalStore;
}
