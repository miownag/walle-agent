/**
 * MemoryPlugin — wires SessionLog + ToolResultVault + MemoryManager into an Agent.
 */

import * as path from "node:path";
import type {
  AgentContext,
  ContextItem,
  ModelMessage,
  WallePlugin,
} from "@walle-agent/core";

import { MemoryManager } from "./memory-manager.js";
import { SessionLog } from "./session-log.js";
import { ToolResultVault, tryDecodeEviction } from "./tool-result-vault.js";
import { buildRememberTools } from "./remember-tools.js";
import type { MemoryPluginConfig, EvictedToolResult } from "./memory-types.js";

const DEFAULT_ROOT = "./.walle";

interface RunState {
  sessionId?: string;
  runId: string;
  turn: number;
  userLogged: boolean;
  /** Track evicted tool call ids so we don't double-log. */
  evictedToolCallIds: Set<string>;
}

export class MemoryPlugin implements WallePlugin {
  readonly name = "memory";
  readonly version = "0.1.0";

  /** Resolved root directory. Exposed so `Agent.resume` can locate sessions. */
  readonly rootDir: string;
  readonly sessionsDir: string;

  readonly manager!: MemoryManager;
  readonly sessionLog?: SessionLog;
  readonly vault?: ToolResultVault;

  private readonly runs = new Map<string, RunState>();
  private readonly sessionsEnabled: boolean;
  private readonly largeEnabled: boolean;
  private readonly longTermEnabled: boolean;
  private readonly topK: number;

  constructor(private readonly config: MemoryPluginConfig = {}) {
    const root = config.rootDir ?? DEFAULT_ROOT;
    this.rootDir = root;

    this.sessionsEnabled = config.sessions?.enabled ?? true;
    this.largeEnabled = config.largeToolResults?.enabled ?? true;
    this.longTermEnabled = config.longTerm?.enabled ?? true;
    this.topK = config.longTerm?.topK ?? 8;

    this.sessionsDir = config.sessions?.dir ?? path.join(root, "sessions");
    if (this.sessionsEnabled) {
      this.sessionLog = new SessionLog(this.sessionsDir);
    }

    if (this.largeEnabled) {
      const dir =
        config.largeToolResults?.dir ?? path.join(root, "memory", "large-tool-results");
      this.vault = new ToolResultVault({
        dir,
        thresholdChars: config.largeToolResults?.thresholdChars,
        previewHeadLines: config.largeToolResults?.previewHeadLines,
        previewTailLines: config.largeToolResults?.previewTailLines,
      });
    }

    if (this.longTermEnabled) {
      const filePath = config.longTerm?.filePath ?? path.join(root, "memory", "memories.jsonl");
      this.manager = new MemoryManager({
        filePath,
        dedupThreshold: config.longTerm?.dedupThreshold,
      });
    }
  }

  async install(ctx: AgentContext): Promise<void> {
    if (this.longTermEnabled) {
      await this.manager.init();
      for (const tool of buildRememberTools(this.manager)) {
        ctx.registerTool(tool);
      }
      // Expose the manager so downstream plugins (e.g. EvolutionPlugin) can
      // drive it programmatically without depending on this package's import
      // graph.
      (ctx as unknown as { __memoryManager?: MemoryManager }).__memoryManager =
        this.manager;
    }

    // Register hooks
    ctx.registerHook("onRunStart", async ({ input, runId, sessionId }) => {
      this.runs.set(runId, {
        sessionId,
        runId,
        turn: 0,
        userLogged: false,
        evictedToolCallIds: new Set(),
      });

      if (this.sessionsEnabled && this.sessionLog && sessionId) {
        await this.sessionLog.appendRunStart(sessionId, runId);
        // First record: the user message (turn 0).
        const userMessage: ModelMessage = {
          role: "user",
          content: input.content,
        };
        const state = this.runs.get(runId)!;
        await this.sessionLog.appendMessage(sessionId, runId, state.turn++, userMessage);
        state.userLogged = true;
      }
    });

    ctx.registerHook("afterModelCall", async ({ message }) => {
      const runId = this.findActiveRunId();
      if (!runId) return;
      const state = this.runs.get(runId)!;

      if (this.sessionsEnabled && this.sessionLog && state.sessionId) {
        await this.sessionLog.appendMessage(state.sessionId, runId, state.turn++, message);
      }
    });

    ctx.registerHook("afterToolCall", async ({ record }) => {
      const runId = this.findActiveRunId();
      if (!runId) return;
      const state = this.runs.get(runId)!;

      // Build the tool message (core will also push it into live messages — we just
      // need to control what goes onto disk).
      const raw = this.serializeToolOutput(record.output);

      let contentForDisk: string = raw;

      if (this.largeEnabled && this.vault && this.vault.shouldEvict(raw)) {
        const envelope = await this.vault.evict({
          toolCallId: record.id,
          toolName: record.name,
          content: raw,
          status: record.status,
        });
        contentForDisk = JSON.stringify(envelope);
        state.evictedToolCallIds.add(record.id);
      }

      if (this.sessionsEnabled && this.sessionLog && state.sessionId) {
        const toolMessage: ModelMessage = {
          role: "tool",
          toolCallId: record.id,
          content: contentForDisk,
        };
        await this.sessionLog.appendMessage(state.sessionId, runId, state.turn++, toolMessage);
      }
    });

    ctx.registerHook("onRunEnd", async ({ runId, sessionId, status }) => {
      if (this.sessionsEnabled && this.sessionLog && sessionId) {
        await this.sessionLog.appendRunEnd(sessionId, runId, {
          endAt: new Date().toISOString(),
          status,
        });
      }
      this.runs.delete(runId);
    });

    ctx.registerHook("onRunError", async ({ runId, sessionId }) => {
      if (this.sessionsEnabled && this.sessionLog && sessionId) {
        await this.sessionLog.appendRunEnd(sessionId, runId, {
          endAt: new Date().toISOString(),
          status: "error",
        });
      }
    });

    // Event listeners

    ctx.events.on("collect_messages", async ({ sessionId, into }) => {
      if (!this.sessionsEnabled || !this.sessionLog || !sessionId) return;
      const records = await this.sessionLog.readMessages(sessionId);
      if (records.length === 0) return;

      // The current run's records must be excluded — `run_start` already appended
      // the current user message, and PromptBuilder will add it as the fresh user input.
      const currentRunId = this.findActiveRunId();

      // Determine which run was the most-recent prior run (by file order).
      // Rule: if the very last prior run is "user-cancelled", rehydrate full content
      // for that run's evicted tool results; all other evicted messages get summarized.
      const lastRun = await this.sessionLog.lastRun(sessionId, currentRunId);
      const lastCancelledRunId =
        lastRun && lastRun.status === "user-cancelled" ? lastRun.runId : undefined;

      for (const rec of records) {
        if (rec.runId === currentRunId) continue;

        const msg = rec.message;
        if (msg.role === "tool") {
          const envelope = tryDecodeEviction(msg.content);
          if (envelope) {
            const rehydrated = await this.rehydrateToolMessage(
              envelope,
              rec.runId === lastCancelledRunId,
            );
            into.push({ ...msg, content: rehydrated });
            continue;
          }
        }
        into.push(msg);
      }
    });

    ctx.events.on("collect_context", async ({ query, items }) => {
      if (!this.longTermEnabled || !this.manager) return;
      const memories = await this.manager.retrieve(query, { longTopK: this.topK });
      for (const mem of memories) {
        const item: ContextItem = {
          source: "memory",
          priority: this.priorityFor(mem.importance, mem.scope === "long"),
          content: `[${mem.type}] ${mem.content}`,
          estimatedTokens: Math.ceil(mem.content.length / 4),
          metadata: { memoryId: mem.id, scope: mem.scope, tags: mem.tags },
        };
        items.push(item);
      }
    });
  }

  async dispose(): Promise<void> {
    if (this.sessionLog) await this.sessionLog.flush();
  }

  /** Absolute directory where a given session's JSONL files live. */
  sessionDir(sessionId: string): string {
    return path.join(this.sessionsDir, sessionId);
  }

  // ─── internals ──────────────────────────────────────────────────

  private async rehydrateToolMessage(
    envelope: EvictedToolResult,
    rehydrateFull: boolean,
  ): Promise<string> {
    if (rehydrateFull && this.vault) {
      const full = await this.vault.readFull(envelope.toolCallId);
      if (full != null) return full;
    }
    // Fallback: summarized form.
    if (this.vault) return this.vault.formatSummary(envelope);
    return envelope.preview;
  }

  private priorityFor(importance: number, long: boolean): number {
    const base = long ? 80 : 50;
    return base + Math.round(importance * 20);
  }

  private findActiveRunId(): string | undefined {
    // There's normally exactly one in-flight run per agent. If multiple,
    // pick the most-recently inserted.
    let last: string | undefined;
    for (const id of this.runs.keys()) last = id;
    return last;
  }

  private serializeToolOutput(output: unknown): string {
    if (typeof output === "string") return output;
    try {
      return JSON.stringify(output);
    } catch {
      return String(output);
    }
  }
}
