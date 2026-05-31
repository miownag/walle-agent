/**
 * TracePlugin — subscribes to EventBus and persists per-event records to a
 * `TraceStore`. One traceId per `agent.run` (rolled at `run_start`).
 *
 * `recordContent: false` (default) redacts payload contents that may carry
 * user/customer data. Phase-6 evolution machinery reads `tool_call_end`
 * + `model_call_*` events for prompt-quality scoring, so the trace plugin is
 * effectively the audit log for self-improvement.
 */

import type {
  AgentContext,
  ContextItem,
  ModelMessage,
  ModelToolCall,
  ToolCallRecord,
  WallePlugin,
} from "@walle-agent/core";
import type { RunStatus } from "@walle-agent/core";
import { InMemoryTraceStore } from "./in-memory-trace-store.js";
import { JSONLTraceStore } from "./jsonl-trace-store.js";
import type {
  TraceEvent,
  TracePluginConfig,
  TraceStore,
} from "./trace-types.js";

const REDACTED = "[redacted]";

export class TracePlugin implements WallePlugin {
  readonly name = "trace";
  readonly version = "0.1.0";

  private store!: TraceStore;
  private currentTraceId?: string;
  private installed = false;

  constructor(private readonly config: TracePluginConfig = {}) {}

  // ─── lifecycle ──────────────────────────────────────────────────

  async install(ctx: AgentContext): Promise<void> {
    this.store = this.createStore();
    this.installed = true;

    ctx.events.on("run_start", async (payload) => {
      this.currentTraceId = newId();
      await this.record({
        type: "run_start",
        data: {
          input: this.config.recordContent ? this.serializeInput(payload.input) : REDACTED,
          userId: payload.input.userId,
          sessionId: payload.input.sessionId ?? payload.sessionId,
          runId: payload.runId,
        },
      });
    });

    ctx.events.on("run_end", async (payload) => {
      await this.record({
        type: "run_end",
        data: {
          messageCount: (payload.messages as ModelMessage[]).length,
          status: payload.status as RunStatus,
          runId: payload.runId,
          sessionId: payload.sessionId,
          error: payload.error ? String(payload.error) : undefined,
        },
      });
    });

    ctx.events.on("model_call_start", async ({ messages }) => {
      await this.record({
        type: "model_call_start",
        data: { messageCount: (messages as ModelMessage[]).length },
      });
    });

    ctx.events.on("model_call_end", async ({ message }) => {
      const m = message as ModelMessage;
      await this.record({
        type: "model_call_end",
        data: {
          role: m.role,
          hasToolCalls: !!m.toolCalls?.length,
          toolCallCount: m.toolCalls?.length ?? 0,
          content: this.config.recordContent ? this.serializeContent(m.content) : undefined,
        },
      });
    });

    ctx.events.on("tool_call_start", async ({ call }) => {
      const c = call as ModelToolCall;
      await this.record({
        type: "tool_call_start",
        data: {
          name: c.name,
          arguments: this.config.recordContent ? c.arguments : REDACTED,
          callId: c.id,
        },
      });
    });

    ctx.events.on("tool_call_end", async ({ record }) => {
      const r = record as ToolCallRecord;
      await this.record({
        type: "tool_call_end",
        data: {
          name: r.name,
          status: r.status,
          durationMs: r.durationMs,
          callId: r.id,
          error: r.error,
          output: this.config.recordContent ? r.output : undefined,
        },
        durationMs: r.durationMs,
      });
    });

    ctx.events.on("collect_context", async ({ query, items }) => {
      const list = items as ContextItem[];
      await this.record({
        type: "context_collect",
        data: {
          query: this.config.recordContent ? query : REDACTED,
          itemCount: list.length,
          sources: list.map((i) => i.source),
        },
      });
    });

    ctx.events.on("memory_write", async ({ item }) => {
      await this.record({
        type: "memory_write",
        data: { item: this.config.recordContent ? item : REDACTED },
      });
    });

    ctx.events.on("skill_write", async ({ skill }) => {
      await this.record({
        type: "skill_write",
        data: { skill: this.config.recordContent ? skill : REDACTED },
      });
    });

    ctx.events.on("evolution_proposal", async (payload) => {
      await this.record({
        type: "evolution_proposal",
        data: {
          proposalType: payload.type,
          proposal: this.config.recordContent ? payload.proposal : REDACTED,
        },
      });
    });
  }

  async dispose(): Promise<void> {
    await this.store?.dispose?.();
  }

  // ─── public API ─────────────────────────────────────────────────

  getStore(): TraceStore {
    return this.store;
  }

  /** Whether `install()` has run (for tests / introspection). */
  isInstalled(): boolean {
    return this.installed;
  }

  /** Latest traceId assigned at `run_start`, or `undefined` if no run yet. */
  getCurrentTraceId(): string | undefined {
    return this.currentTraceId;
  }

  // ─── internals ──────────────────────────────────────────────────

  private async record(event: Omit<TraceEvent, "id" | "traceId" | "timestamp">): Promise<void> {
    const sample = this.config.sampleRate;
    if (sample !== undefined && sample < 1 && Math.random() > sample) return;

    const full: TraceEvent = {
      id: newId(),
      traceId: this.currentTraceId ?? "unknown",
      timestamp: new Date().toISOString(),
      ...event,
    };

    try {
      await this.store.write(full);
    } catch (err) {
      // Trace MUST never crash the agent — log and swallow.
      console.error("[trace] failed to write event:", err);
    }
  }

  private createStore(): TraceStore {
    if (this.config.customStore) return this.config.customStore;
    switch (this.config.store) {
      case "memory":
        return new InMemoryTraceStore();
      case "jsonl":
      default:
        return new JSONLTraceStore(this.config.storePath ?? "./.walle/traces");
    }
  }

  private serializeInput(input: unknown): unknown {
    if (input && typeof input === "object" && "content" in input) {
      const c = (input as { content: unknown }).content;
      return typeof c === "string" ? c : "[content-blocks]";
    }
    return input;
  }

  private serializeContent(content: ModelMessage["content"]): unknown {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return `[${content.length} blocks]`;
    return undefined;
  }
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `trace-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
