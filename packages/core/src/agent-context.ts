/**
 * AgentContext — the interface plugins interact with.
 */

import type { Agent } from "./agent.js";
import type { ResolvedAgentConfig } from "./agent-config.js";
import type { EventBus } from "./events.js";
import type { Tool } from "./tool.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { AgentHooks, HookManager } from "./hooks.js";
import type { Middleware, MiddlewarePipeline } from "./middleware.js";
import type { WallePlugin } from "./plugin.js";
import type { SubAgentRegistry } from "./sub-agent-registry.js";

// ─── AgentContext Interface ────────────────────────────────────────

export interface AgentContext {
  readonly agent: Agent;
  readonly config: ResolvedAgentConfig;
  readonly events: EventBus;
  /**
   * Per-Agent registry of sub-agent types. Plugins (e.g. team's
   * `SubAgentsPlugin`) call `subAgents.register({ type, … })` during
   * `install()` to expose types to the built-in `task` tool.
   */
  readonly subAgents: SubAgentRegistry;

  registerTool(tool: Tool): void;
  registerHook<K extends keyof AgentHooks>(name: K, handler: AgentHooks[K]): void;
  registerMiddleware(middleware: Middleware): void;
  getPlugin<T extends WallePlugin>(name: string): T | undefined;
}

// ─── AgentContextImpl ──────────────────────────────────────────────

export interface AgentContextImplOptions {
  agent: Agent;
  config: ResolvedAgentConfig;
  events: EventBus;
  toolRegistry: ToolRegistry;
  hookManager: HookManager;
  middlewarePipeline: MiddlewarePipeline;
  subAgents: SubAgentRegistry;
}

export class AgentContextImpl implements AgentContext {
  readonly agent: Agent;
  readonly config: ResolvedAgentConfig;
  readonly events: EventBus;
  readonly subAgents: SubAgentRegistry;

  private toolRegistry: ToolRegistry;
  private hookManager: HookManager;
  private middlewarePipeline: MiddlewarePipeline;

  constructor(options: AgentContextImplOptions) {
    this.agent = options.agent;
    this.config = options.config;
    this.events = options.events;
    this.toolRegistry = options.toolRegistry;
    this.hookManager = options.hookManager;
    this.middlewarePipeline = options.middlewarePipeline;
    this.subAgents = options.subAgents;
  }

  registerTool(tool: Tool): void {
    this.toolRegistry.register(tool);
  }

  registerHook<K extends keyof AgentHooks>(name: K, handler: AgentHooks[K]): void {
    this.hookManager.register(name, handler);
  }

  registerMiddleware(middleware: Middleware): void {
    this.middlewarePipeline.use(middleware);
  }

  getPlugin<T extends WallePlugin>(name: string): T | undefined {
    return this.config.plugins.find((p) => p.name === name) as T | undefined;
  }
}
