/**
 * SessionLog — append-only JSONL persistence for messages and run lifecycle.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createReadStream, existsSync } from "node:fs";
import * as readline from "node:readline";
import type { ModelMessage } from "@walle-agent/core";
import type { SessionMessageRecord, SessionRunRecord } from "./memory-types.js";

interface EndUpdate {
  endAt: string;
  status: NonNullable<SessionRunRecord["status"]>;
  error?: string;
}

/**
 * Per-session append-only log. One instance per plugin; serializes writes
 * through a simple promise chain so interleaved hooks produce a well-formed
 * JSONL even if fired in parallel.
 */
export class SessionLog {
  /** Root dir: `<rootDir>/sessions`. */
  private root: string;
  /** Write queue keyed by sessionId. */
  private queues = new Map<string, Promise<unknown>>();

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
    this.queues.set(
      sessionId,
      next.catch(() => void 0),
    );
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
      await fs.appendFile(this.messagesFile(sessionId), JSON.stringify(record) + "\n");
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
      await fs.appendFile(this.runsFile(sessionId), JSON.stringify(record) + "\n");
    });
  }

  async appendRunEnd(sessionId: string, runId: string, update: EndUpdate): Promise<void> {
    return this.enqueue(sessionId, async () => {
      await this.ensureDir(sessionId);
      const record: SessionRunRecord = {
        runId,
        sessionId,
        endAt: update.endAt,
        status: update.status,
        ...(update.error ? { error: update.error } : {}),
      };
      await fs.appendFile(this.runsFile(sessionId), JSON.stringify(record) + "\n");
    });
  }

  async readMessages(sessionId: string): Promise<SessionMessageRecord[]> {
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
  }

  async readRuns(sessionId: string): Promise<SessionRunRecord[]> {
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
  async lastRun(sessionId: string, excludeRunId?: string): Promise<SessionRunRecord | undefined> {
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
    await Promise.all([...this.queues.values()].map((p) => p.catch(() => void 0)));
  }
}
