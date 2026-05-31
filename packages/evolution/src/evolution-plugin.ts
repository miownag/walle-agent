/**
 * EvolutionPlugin — wires the EvolutionEngine into the Agent's run lifecycle.
 *
 * Dependency order: MemoryPlugin (required) → SkillsPlugin (optional) → EvolutionPlugin.
 * The plugin looks up those dependencies via the `AgentContext.__memoryManager` /
 * `__skillRegistry` attachment points set by the upstream plugins.
 */

import * as path from "node:path";
import type { AgentContext, ModelMessage, WallePlugin } from "@walle-agent/core";
import type { MemoryManager } from "@walle-agent/memory";
import type { SkillRegistry } from "@walle-agent/skills";

import { EvolutionEngine } from "./evolution-engine.js";
import { ProposalFileStore } from "./proposal-file-store.js";
import type {
  EvolutionProposal,
  EvolutionPluginConfig,
  ProposalStore,
} from "./evolution-types.js";

const DEFAULT_ROOT = "./.walle/evolution";

interface ContextLookups {
  __memoryManager?: MemoryManager;
  __skillRegistry?: SkillRegistry;
}

export class EvolutionPlugin implements WallePlugin {
  readonly name = "evolution";
  readonly version = "0.1.0";

  /** Exposed for tests / external observers. */
  readonly proposalStore: ProposalStore;
  engine?: EvolutionEngine;

  private turnCounter = 0;

  constructor(private readonly config: EvolutionPluginConfig = {}) {
    const root = config.rootDir ?? DEFAULT_ROOT;
    const storePath = config.proposalStorePath ?? path.join(root, "proposals");
    this.proposalStore = new ProposalFileStore(path.resolve(storePath));
  }

  async install(ctx: AgentContext): Promise<void> {
    const lookups = ctx as unknown as ContextLookups;
    const memory = lookups.__memoryManager;

    if (!memory) {
      throw new Error(
        "EvolutionPlugin requires MemoryPlugin to be installed first (it expects " +
          "`ctx.__memoryManager`).",
      );
    }

    this.engine = new EvolutionEngine({
      config: this.config,
      model: ctx.config.model,
      memory,
      skills: lookups.__skillRegistry,
      proposalStore: this.proposalStore,
    });

    ctx.registerHook("onRunEnd", async (payload) => {
      this.turnCounter += 1;
      const messages = payload.messages ?? [];
      // Run evolution out-of-band so it does not delay the user-visible response.
      // Fire-and-forget; errors are swallowed inside the engine.
      void this.engine!.afterRun({
        turnCounter: this.turnCounter,
        runId: payload.runId,
        sessionId: payload.sessionId,
        messages: copyMessages(messages),
      });
    });
  }

  // ─── External API ────────────────────────────────────────────────

  /** List pending proposals. */
  pending(): Promise<EvolutionProposal[]> {
    return this.proposalStore.list({ status: "pending" });
  }

  /**
   * Approve a pending proposal and apply it to memory/skills immediately.
   * Returns the updated proposal, or `undefined` if the id is unknown.
   */
  async approveAndApply(id: string, note?: string): Promise<EvolutionProposal | undefined> {
    const proposal = await this.proposalStore.approve(id, note);
    if (!proposal || !this.engine) return proposal;
    await this.engine.applyProposal(proposal);
    await this.proposalStore.markApplied(id);
    return await this.proposalStore.get(id);
  }

  reject(id: string, note?: string): Promise<EvolutionProposal | undefined> {
    return this.proposalStore.reject(id, note);
  }

  /** Force-run evolution for the given messages. Useful for testing / CLIs. */
  async runEvolution(runId: string, sessionId: string | undefined, messages: ModelMessage[]): Promise<void> {
    if (!this.engine) throw new Error("EvolutionPlugin not installed yet");
    this.turnCounter += 1;
    await this.engine.afterRun({
      turnCounter: this.turnCounter,
      runId,
      sessionId,
      messages: copyMessages(messages),
    });
  }
}

function copyMessages(messages: ModelMessage[]): ModelMessage[] {
  // Shallow copy — evolution only reads.
  return messages.slice();
}
