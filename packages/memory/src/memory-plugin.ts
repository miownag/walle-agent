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
import {
  partitionByTurns,
  buildPlaceholder,
  isPlaceholder,
} from "@walle-agent/core";

import { MemoryManager } from "./memory-manager.js";
import { SessionLog } from "./session-log.js";
import { ToolResultVault, tryDecodeEviction } from "./tool-result-vault.js";
import { buildRememberTools } from "./remember-tools.js";
import type { MemoryPluginConfig, EvictedToolResult } from "./memory-types.js";

const DEFAULT_ROOT = "./.walle";
let warnedAboutLegacy = false;

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
  readonly keepRecentTurns: number;

  private readonly runs = new Map<string, RunState>();
  private readonly sessionsEnabled: boolean;
  private readonly toolResultsEnabled: boolean;
  private readonly longTermEnabled: boolean;
  private readonly topK: number;

  constructor(private readonly config: MemoryPluginConfig = {}) {
    const root = config.rootDir ?? DEFAULT_ROOT;
    this.rootDir = root;

    // Merge legacy `largeToolResults` into `toolResults` (new wins).
    const legacy = config.largeToolResults;
    const next = config.toolResults;
    if (legacy && !warnedAboutLegacy) {
      warnedAboutLegacy = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[walle-memory] `largeToolResults` is deprecated; rename to `toolResults`.",
      );
    }
    const toolResultsCfg = {
      enabled: next?.enabled ?? legacy?.enabled ?? true,
      dir: next?.dir ?? legacy?.dir,
      thresholdChars: next?.thresholdChars ?? legacy?.thresholdChars ?? 0,
      keepRecentTurns: next?.keepRecentTurns ?? 3,
      previewHeadLines: next?.previewHeadLines ?? legacy?.previewHeadLines ?? 10,
      previewTailLines: next?.previewTailLines ?? legacy?.previewTailLines ?? 10,
    };

    this.sessionsEnabled = config.sessions?.enabled ?? true;
    this.toolResultsEnabled = toolResultsCfg.enabled;
    this.longTermEnabled = config.longTerm?.enabled ?? true;
    this.topK = config.longTerm?.topK ?? 8;
    this.keepRecentTurns = toolResultsCfg.keepRecentTurns;

    this.sessionsDir = config.sessions?.dir ?? path.join(root, "sessions");
    if (this.sessionsEnabled) {
      this.sessionLog = new SessionLog(this.sessionsDir);
    }

    if (this.toolResultsEnabled) {
      const dir =
        toolResultsCfg.dir ?? path.join(root, "memory", "large-tool-results");
      this.vault = new ToolResultVault({
        dir,
        thresholdChars: toolResultsCfg.thresholdChars,
        previewHeadLines: toolResultsCfg.previewHeadLines,
        previewTailLines: toolResultsCfg.previewTailLines,
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

      if (this.toolResultsEnabled && this.vault && this.vault.shouldEvict(raw)) {
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

    // ── Micro compression: rewrite older tool messages into placeholders ──
    ctx.events.on("compact_messages", async ({ messages, keepRecentTurns }) => {
      if (!this.toolResultsEnabled || !this.vault) return;
      const k = keepRecentTurns ?? this.keepRecentTurns;
      const partition = partitionByTurns(messages, k);
      if (partition.evictableIndices.size === 0) return;

      for (const i of partition.evictableIndices) {
        const msg = messages[i];
        if (msg.role !== "tool") continue;
        if (isPlaceholder(msg.content)) continue;

        // Already an envelope? Re-render with current preview/idx.
        const envelope = tryDecodeEviction(msg.content);
        if (envelope) {
          const idx = (await this.vault.getIdx(envelope.toolCallId)) ?? 0;
          messages[i] = {
            ...msg,
            content: buildPlaceholder({
              idx,
              toolName: envelope.toolName,
              toolCallId: envelope.toolCallId,
              size: envelope.size,
              vaultPath: envelope.path,
              preview: envelope.preview,
            }),
          };
          continue;
        }

        // Live content — only rewrite when we have an evictable size.
        const raw = typeof msg.content === "string" ? msg.content : "";
        if (!raw) continue;
        if (this.vault.thresholdChars > 0 && raw.length <= this.vault.thresholdChars) {
          continue;
        }
        const toolCallId = msg.toolCallId;
        if (!toolCallId) continue;
        const toolName =
          (msg.metadata?.toolName as string | undefined) ?? "unknown";
        const status = msg.metadata?.status as
          | "success"
          | "error"
          | "denied"
          | "timeout"
          | undefined;
        const ev = await this.vault.ensure({
          toolCallId,
          toolName,
          content: raw,
          status,
        });
        messages[i] = {
          ...msg,
          content: buildPlaceholder({
            idx: ev.idx,
            toolName: ev.toolName,
            toolCallId: ev.toolCallId,
            size: ev.size,
            vaultPath: ev.path,
            preview: ev.preview,
          }),
        };
      }
    });

    // ── read_tool_result backend ─────────────────────────────────────────
    ctx.events.on("vault_read", async (payload) => {
      if (!this.vault) return;
      const slice = await this.vault.readSlice(payload.toolCallId, {
        offset: payload.offset,
        limit: payload.limit,
      });
      if (!slice) {
        payload.result.value = { error: "tool result not found" };
        return;
      }
      payload.result.value = slice;
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
