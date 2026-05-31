/**
 * Hooks system — side-effect listeners for agent lifecycle events.
 */

import type { ModelMessage, ModelToolCall } from "./message.js";
import type { ToolCallRecord } from "./tool.js";
import type { AgentInput, AgentResult } from "./agent-config.js";
import type { TokenUsage } from "./types.js";
import type { AgentContext } from "./agent-context.js";
import type { RunStatus } from "./events.js";

// ─── AgentHooks Type ───────────────────────────────────────────────

export interface AgentHooks {
  /** Agent initialization complete */
  onInit: (ctx: AgentContext) => Promise<void> | void;
  /** A run starts */
  onRunStart: (payload: {
    input: AgentInput;
    runId: string;
    sessionId?: string;
  }) => Promise<void> | void;
  /** A run ends */
  onRunEnd: (payload: {
    /** Best-effort result; may be absent when emitted from streaming generators. */
    result?: AgentResult;
    runId: string;
    sessionId?: string;
    status: RunStatus;
    /** The in-memory message list as the run ended (system + history + current + tool loop). */
    messages?: ModelMessage[];
  }) => Promise<void> | void;
  /** A run errors */
  onRunError: (payload: {
    error: unknown;
    runId: string;
    sessionId?: string;
  }) => Promise<void> | void;
  /** Before LLM call */
  beforeModelCall: (payload: { messages: ModelMessage[] }) => Promise<void> | void;
  /** After LLM call */
  afterModelCall: (payload: { message: ModelMessage; usage?: TokenUsage }) => Promise<void> | void;
  /** Before tool call */
  beforeToolCall: (payload: { call: ModelToolCall }) => Promise<void> | void;
  /** After tool call */
  afterToolCall: (payload: { record: ToolCallRecord }) => Promise<void> | void;
}

// ─── HookManager ───────────────────────────────────────────────────

export class HookManager {
  private hooks = new Map<string, Set<Function>>();

  register<K extends keyof AgentHooks>(name: K, handler: AgentHooks[K]): () => void {
    if (!this.hooks.has(name)) {
      this.hooks.set(name, new Set());
    }
    this.hooks.get(name)!.add(handler);
    return () => {
      this.hooks.get(name)?.delete(handler);
    };
  }

  registerAll(hooks: Partial<AgentHooks>): void {
    for (const [name, handler] of Object.entries(hooks)) {
      if (handler) {
        this.register(name as keyof AgentHooks, handler as AgentHooks[keyof AgentHooks]);
      }
    }
  }

  async emit<K extends keyof AgentHooks>(
    name: K,
    payload: Parameters<AgentHooks[K]>[0],
  ): Promise<void> {
    const handlers = this.hooks.get(name);
    if (!handlers?.size) return;

    const results = await Promise.allSettled(
      [...handlers].map((handler) => {
        try {
          return Promise.resolve((handler as Function)(payload));
        } catch (err) {
          return Promise.reject(err);
        }
      }),
    );

    for (const result of results) {
      if (result.status === "rejected") {
        console.error(`[Hook ${name}] Error:`, result.reason);
      }
    }
  }
}
