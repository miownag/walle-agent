/**
 * SandboxPlugin — wires a Sandbox + the `shell` tool into an Agent.
 *
 * Coexists with the built-in `bashTool` (`@walle-agent/core`) — they have
 * the same risk profile, so the LLM may call either. Operators who want
 * sandbox-only execution should pass
 * `useBuiltinTools: { excludeTools: ["bash"] }` on the agent config.
 */

import type { AgentContext, WallePlugin } from "@walle-agent/core";
import { LocalSandbox } from "./local-sandbox.js";
import { DockerSandbox } from "./docker-sandbox.js";
import { buildShellTool } from "./shell-tool.js";
import type { Sandbox, SandboxPluginConfig } from "./sandbox-types.js";

export class SandboxPlugin implements WallePlugin {
  readonly name = "sandbox";
  readonly version = "0.1.0";

  readonly sandbox: Sandbox;

  constructor(private readonly config: SandboxPluginConfig) {
    this.sandbox = createSandbox(config);
  }

  async install(ctx: AgentContext): Promise<void> {
    ctx.registerTool(buildShellTool(this.sandbox));

    // Expose the sandbox so future plugins (e.g. Code Skill executor) can
    // reach it without importing this package directly. Matches the
    // `__memoryManager` / `__skillRegistry` / `__mcpManager` precedent.
    (ctx as unknown as { __sandbox?: Sandbox }).__sandbox = this.sandbox;
  }

  getSandbox(): Sandbox {
    return this.sandbox;
  }

  async dispose(): Promise<void> {
    await this.sandbox.dispose?.();
  }
}

function createSandbox(config: SandboxPluginConfig): Sandbox {
  if (config.type === "docker") {
    return new DockerSandbox({ ...config.docker, runner: config.runner });
  }
  return new LocalSandbox({ ...(config.local ?? {}), runner: config.runner });
}
