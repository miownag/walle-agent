/**
 * SubAgentsPlugin — plugin entry-point for the dynamic `task` sub-agent
 * dispatcher (see docs/14-team-swarm.md#dynamic-subagenttask-工具).
 *
 * Equivalent to passing `AgentConfig.subAgents` directly, but packaged as a
 * `WallePlugin` for users who manage Agent assembly through the `plugins`
 * array. The two paths are mutually exclusive — install() throws if both
 * are used on the same Agent.
 *
 * Internally registers each `SubAgentDefinition` into `ctx.subAgents`, the
 * per-Agent `SubAgentRegistry` already wired into the built-in `task`
 * tool. No new tool registration happens here — the core runtime owns that.
 */

import type { AgentContext, SubAgentDefinition, SubAgentRegistry, WallePlugin } from "@walle-agent/core";

export interface SubAgentsPluginOptions {
  /**
   * Sub-agent type definitions. Each `type` must be unique across this
   * plugin's set; duplicates throw at install-time.
   */
  types: SubAgentDefinition[];
}

export class SubAgentsPlugin implements WallePlugin {
  readonly name = "sub-agents";
  readonly version = "0.1.0";

  private readonly options: SubAgentsPluginOptions;
  /**
   * Reference to the per-Agent registry, captured during install. Tests and
   * advanced consumers can read it via `getRegistry()`.
   */
  private registry?: SubAgentRegistry;

  constructor(options: SubAgentsPluginOptions) {
    if (!options || !Array.isArray(options.types)) {
      throw new Error("SubAgentsPlugin: options.types must be an array");
    }
    this.options = options;
  }

  install(ctx: AgentContext): void {
    if (ctx.config.subAgents.length > 0) {
      throw new Error(
        "SubAgentsPlugin: AgentConfig.subAgents is already populated. " +
          "Pick one entry point (config.subAgents OR SubAgentsPlugin) — " +
          "using both leads to ambiguous duplicate-type errors.",
      );
    }

    this.registry = ctx.subAgents;
    for (const def of this.options.types) {
      ctx.subAgents.register(def);
    }
  }

  /**
   * Returns the registry this plugin populated. Available only after
   * `install()` has run; throws otherwise. Mostly useful for tests and
   * advanced flows that want to inspect or mutate the live registry.
   */
  getRegistry(): SubAgentRegistry {
    if (!this.registry) {
      throw new Error(
        "SubAgentsPlugin.getRegistry: install() has not been called yet. " +
          "Pass this plugin to Agent.create({ plugins: [...] }) first.",
      );
    }
    return this.registry;
  }
}
