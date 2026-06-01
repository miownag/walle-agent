/**
 * Agent — the main public API class.
 */

import { existsSync } from "node:fs";
import type { AgentConfig, AgentInput, AgentResult, RunOptions } from "./agent-config.js";
import { resolveConfig } from "./agent-config.js";
import { AgentRuntime } from "./agent-runtime.js";
import { AgentStream } from "./stream.js";
import type { WallePlugin } from "./plugin.js";
import type { EventBus } from "./events.js";
import type { Tool } from "./tool.js";
import type { LLMProvider } from "./llm-provider.js";

/**
 * Narrow contract used by `Agent.resume` to validate a session on disk.
 * Any plugin named "memory" that implements this shape is accepted, so we
 * don't have to hard-depend on `@walle-agent/memory` from core.
 */
interface MemoryPluginLike extends WallePlugin {
  readonly rootDir?: string;
  sessionDir?(sessionId: string): string;
}

export class Agent {
  readonly id: string;
  readonly name: string;
  /**
   * Stable session id. Auto-assigned at `Agent.create` if the caller didn't
   * provide `config.sessionId`. Every `agent.run()` defaults to this id,
   * so `MemoryPlugin` can persist the conversation across runs and
   * `Agent.resume(sessionId, config)` can re-attach to it.
   */
  readonly sessionId: string;

  private runtime: AgentRuntime;

  private constructor(config: ReturnType<typeof resolveConfig>) {
    this.id = config.id;
    this.name = config.name;
    this.sessionId = config.sessionId;
    this.runtime = new AgentRuntime(config, this);
  }

  /**
   * Create an Agent instance. Initializes all plugins.
   */
  static async create(config: AgentConfig): Promise<Agent> {
    const resolved = resolveConfig(config);
    const agent = new Agent(resolved);
    await agent.runtime.init();
    return agent;
  }

  /**
   * Resume a prior conversation by sessionId.
   *
   * Internally equivalent to `Agent.create({ ...config, sessionId })` — the
   * memory plugin picks up the session's `messages.jsonl` on the next
   * `run()` via `collect_messages`.
   *
   * Throws if `config.plugins` does not contain a `MemoryPlugin` (resume
   * without persistent memory has no meaning), or if the session directory
   * does not exist on disk.
   */
  static async resume(
    sessionId: string,
    config: Omit<AgentConfig, "sessionId">,
  ): Promise<Agent> {
    if (!sessionId || typeof sessionId !== "string") {
      throw new Error("Agent.resume: sessionId must be a non-empty string");
    }

    const memory = (config.plugins ?? []).find(
      (p) => p.name === "memory",
    ) as MemoryPluginLike | undefined;

    if (!memory) {
      throw new Error(
        "Agent.resume requires a MemoryPlugin in config.plugins; " +
          "without persistent memory there is no session to resume from.",
      );
    }

    // Best-effort: ask the plugin for its session directory.
    const dir =
      typeof memory.sessionDir === "function"
        ? memory.sessionDir(sessionId)
        : memory.rootDir
          ? `${memory.rootDir.replace(/\/+$/, "")}/sessions/${sessionId}`
          : undefined;

    if (dir && !existsSync(dir)) {
      throw new Error(
        `Agent.resume: session "${sessionId}" not found at ${dir}. ` +
          "Check that the sessionId matches an earlier agent and that the " +
          "memory plugin points at the same rootDir.",
      );
    }

    return Agent.create({ ...config, sessionId } as AgentConfig);
  }

  /**
   * Non-streaming execution.
   */
  run(input: string | AgentInput): Promise<AgentResult>;

  /**
   * Non-streaming execution with options (sessionId, signal, etc.).
   */
  run(
    input: string | AgentInput,
    options: Omit<RunOptions, "stream"> & { stream?: false },
  ): Promise<AgentResult>;

  /**
   * Streaming execution.
   */
  run(input: string | AgentInput, options: { stream: true } & RunOptions): AgentStream;

  /**
   * Unified entry point.
   */
  run(input: string | AgentInput, options?: RunOptions): Promise<AgentResult> | AgentStream {
    if (options?.stream) {
      return this.runtime.stream(input, options);
    }
    return this.runtime.run(input, options);
  }

  /**
   * Request interruption of the currently-running loop. No-op when idle.
   * Mirrors what the user typically wants when they hit Ctrl-C.
   *
   * The in-flight run emits `run_end` with `status: "user-cancelled"`; memory
   * plugins persist that status so a subsequent `Agent.resume(sessionId, ...)`
   * can rehydrate the cancelled run's tool outputs to their full content
   * (treating the resumed work as a continuation of the same thought).
   */
  interrupt(reason?: string): void {
    this.runtime.requestInterrupt(reason);
  }

  /** Whether a run is currently in flight. */
  get isRunning(): boolean {
    return this.runtime.isRunning();
  }

  /**
   * Dispose agent, release all resources. Interrupts any in-flight run first.
   */
  async dispose(): Promise<void> {
    this.interrupt("agent-dispose");
    await this.runtime.dispose();
  }

  /**
   * Internal accessor for the runtime's EventBus. Used by built-in tools
   * (e.g. `read_tool_result`, `tool_search`) that need to fan out events to
   * plugins. Not part of the stable public API — prefer plugins for cross-
   * cutting features.
   */
  getEventBus(): EventBus {
    return this.runtime.getEventBus();
  }

  /** Tools currently visible to the LLM (active in the registry). */
  listVisibleTools(): Tool[] {
    return this.runtime.getToolRegistry().listActive();
  }

  /** Tools that are registered but hidden (shadowed) — reachable only via `defer_execute_tool`. */
  listHiddenTools(): Tool[] {
    return this.runtime.getToolRegistry().listShadowed();
  }

  /**
   * Manually trigger macro (conversation summary) compaction. Requires
   * `macroCompression` configured (or sensible defaults applied via the
   * `summaryModel` option). Throws if a run is currently in flight.
   */
  async compact(options?: {
    keepRecentTurns?: number;
    summaryModel?: LLMProvider;
  }): Promise<{
    summary: string;
    beforeMessages: number;
    afterMessages: number;
    beforeTokens: number;
    afterTokens: number;
    droppedMessages: number;
  }> {
    return this.runtime.manualCompact(options);
  }
}
