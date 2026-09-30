/**
 * SessionLog — queued JSONL persistence for messages and run lifecycle.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createReadStream, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import * as readline from "node:readline";
import type { ModelMessage } from "@walle-agent/core";
import type { SessionMessageRecord, SessionRunRecord } from "./memory-types.js";

interface EndUpdate {
  endAt: string;
  status: NonNullable<SessionRunRecord["status"]>;
  error?: string;
}

/**
 * Per-session log. One instance per plugin; serializes reads, appends, and
 * atomic compaction replacements through a promise chain so interleaved hooks
 * always observe a complete JSONL snapshot.
 */
export class SessionLog {
  /** Root dir: `<rootDir>/sessions`. */
  private root: string;
  /** I/O queue keyed by sessionId. */
  private queues = new Map<string, Promise<void>>();

  constructor(rootDir: string) {
    this.root = rootDir;
  }

  private dir(sessionId: string): string {
    return path.join(this.root, sessionId);
  }

  private messagesFile(sessionId: string): string {
    return path.join(this.dir(sessionId), "messages.jsonl");
  }

  private runsFile(sessionId: string): string {
    return path.join(this.dir(sessionId), "runs.jsonl");
  }

  private enqueue<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Keep a rejection-swallowing tail in the queue. Callers still receive
    // `next` (and therefore the real error), while a fire-and-forget caller
    // cannot create an unhandled rejection or poison later operations.
    const tail = next.then(
      () => void 0,
      () => void 0,
    );
    this.queues.set(sessionId, tail);
    void tail.then(() => {
      if (this.queues.get(sessionId) === tail) this.queues.delete(sessionId);
    });
    return next;
  }

  private async ensureDir(sessionId: string): Promise<void> {
    await fs.mkdir(this.dir(sessionId), { recursive: true });
  }

  async appendMessage(
    sessionId: string,
    runId: string,
    turn: number,
    message: ModelMessage,
  ): Promise<void> {
    return this.enqueue(sessionId, async () => {
      await this.ensureDir(sessionId);
      const record: SessionMessageRecord = {
        runId,
        turn,
        timestamp: new Date().toISOString(),
        message,
      };
      await fs.appendFile(
        this.messagesFile(sessionId),
        JSON.stringify(record) + "\n",
      );
    });
  }

  /**
   * Atomically replace a session's persisted conversation with a compacted
   * snapshot. Serialization happens before the operation enters the queue so
   * later mutation of the caller's array cannot change what is committed.
   * The temp file lives beside `messages.jsonl`, making the final rename an
   * atomic same-filesystem replacement.
   */
  async replaceMessages(
    sessionId: string,
    runId: string,
    messages: ReadonlyArray<ModelMessage>,
  ): Promise<void> {
    const timestamp = new Date().toISOString();
    const body = messages
      .map((message, turn) =>
        JSON.stringify({
          runId,
          turn,
          timestamp,
          message,
        } satisfies SessionMessageRecord),
      )
      .join("\n");
    const snapshot = body ? `${body}\n` : "";

    return this.enqueue(sessionId, async () => {
      await this.ensureDir(sessionId);
      const target = this.messagesFile(sessionId);
      const temporary = path.join(
        this.dir(sessionId),
        `.messages.jsonl.${process.pid}.${randomUUID()}.tmp`,
      );
      let handle: fs.FileHandle | undefined;
      try {
        handle = await fs.open(temporary, "wx");
        await handle.writeFile(snapshot, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        await fs.rename(temporary, target);
      } catch (error) {
        await handle?.close().catch(() => void 0);
        await fs.rm(temporary, { force: true }).catch(() => void 0);
        throw error;
      }
    });
  }

  async appendRunStart(sessionId: string, runId: string): Promise<void> {
    return this.enqueue(sessionId, async () => {
      await this.ensureDir(sessionId);
      const record: SessionRunRecord = {
        runId,
        sessionId,
        startAt: new Date().toISOString(),
      };
      await fs.appendFile(
        this.runsFile(sessionId),
        JSON.stringify(record) + "\n",
      );
    });
  }

  async appendRunEnd(
    sessionId: string,
    runId: string,
    update: EndUpdate,
  ): Promise<void> {
    return this.enqueue(sessionId, async () => {
      await this.ensureDir(sessionId);
      const record: SessionRunRecord = {
        runId,
        sessionId,
        endAt: update.endAt,
        status: update.status,
        ...(update.error ? { error: update.error } : {}),
      };
      await fs.appendFile(
        this.runsFile(sessionId),
        JSON.stringify(record) + "\n",
      );
    });
  }

  async readMessages(sessionId: string): Promise<SessionMessageRecord[]> {
    return this.enqueue(sessionId, async () => {
      const file = this.messagesFile(sessionId);
      if (!existsSync(file)) return [];

      const out: SessionMessageRecord[] = [];
      const rl = readline.createInterface({ input: createReadStream(file) });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as SessionMessageRecord);
        } catch {
          // skip malformed line
        }
      }
      return out;
    });
  }

  async readRuns(sessionId: string): Promise<SessionRunRecord[]> {
    return this.enqueue(sessionId, async () => {
      const file = this.runsFile(sessionId);
      if (!existsSync(file)) return [];

      const out: SessionRunRecord[] = [];
      const rl = readline.createInterface({ input: createReadStream(file) });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as SessionRunRecord);
        } catch {
          // skip malformed line
        }
      }
      return out;
    });
  }

  /**
   * Determine the status of each prior runId by folding the run records.
   * The *last* record wins (run-start then run-end pattern).
   */
  async runStatuses(sessionId: string): Promise<Map<string, SessionRunRecord>> {
    const runs = await this.readRuns(sessionId);
    const byId = new Map<string, SessionRunRecord>();
    for (const r of runs) {
      const prev = byId.get(r.runId);
      byId.set(r.runId, { ...prev, ...r });
    }
    return byId;
  }

  /**
   * Return the most-recent prior run record (ordered by file order), optionally
   * excluding a runId (e.g. the current in-flight one).
   * Used to detect "last run was cancelled".
   */
  async lastRun(
    sessionId: string,
    excludeRunId?: string,
  ): Promise<SessionRunRecord | undefined> {
    const runs = await this.readRuns(sessionId);
    if (runs.length === 0) return undefined;

    const order: string[] = [];
    const byId = new Map<string, SessionRunRecord>();
    for (const r of runs) {
      if (!byId.has(r.runId)) order.push(r.runId);
      byId.set(r.runId, { ...byId.get(r.runId), ...r });
    }

    for (let i = order.length - 1; i >= 0; i--) {
      const id = order[i];
      if (excludeRunId && id === excludeRunId) continue;
      return byId.get(id);
    }
    return undefined;
  }

  /**
   * Wait for all queued writes to flush.
   */
  async flush(): Promise<void> {
    await Promise.all(
      [...this.queues.values()].map((p) => p.catch(() => void 0)),
    );
  }
}
