/**
 * @walle-agent/evolution — public API.
 */

export { EvolutionPlugin } from "./evolution-plugin.js";
export { EvolutionEngine } from "./evolution-engine.js";
export { ProposalFileStore } from "./proposal-file-store.js";
export { MEMORY_EXTRACTION_PROMPT, SKILL_EXTRACTION_PROMPT } from "./prompts.js";

export type {
  EvolutionPluginConfig,
  EvolutionProposal,
  EvolutionProposalPayload,
  EvolutionReason,
  EvolutionContext,
  EvolutionEngineDeps,
  MemoryProposal,
  SkillProposal,
  ProposalStore,
  ExplicitRememberConfig,
  PeriodicReviewConfig,
  TaskReviewConfig,
  MemoryCreationConfig,
  SkillCreationConfig,
} from "./evolution-types.js";
