/**
 * JSONLTraceStore — append-only line-delimited JSON, one file per UTC date.
 *
 * Layout: `<dirPath>/<YYYY-MM-DD>.jsonl`. Files are appended atomically per
 * line via `fs.appendFile`. Query walks the directory in reverse-chronological
 * order so `limit` returns the most recent matches first.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  TraceEvent,
  TraceQuery,
  TraceStore,
} from "./trace-types.js";

export class JSONLTraceStore implements TraceStore {
  constructor(private readonly dirPath: string) {}

  async write(event: TraceEvent): Promise<void> {
    await fs.mkdir(this.dirPath, { recursive: true });
    const date = event.timestamp.slice(0, 10);
    const filePath = path.join(this.dirPath, `${date}.jsonl`);
    await fs.appendFile(filePath, JSON.stringify(event) + "\n", "utf8");
  }

  async query(options: TraceQuery): Promise<TraceEvent[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dirPath);
    } catch (err: any) {
      if (err.code === "ENOENT") return [];
      throw err;
    }

    const events: TraceEvent[] = [];
    const sorted = entries.filter((f) => f.endsWith(".jsonl")).sort().reverse();

    for (const file of sorted) {
      let content: string;
      try {
        content = await fs.readFile(path.join(this.dirPath, file), "utf8");
      } catch {
        continue;
      }
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        let event: TraceEvent;
        try {
          event = JSON.parse(line) as TraceEvent;
        } catch {
          continue;
        }

        if (options.traceId && event.traceId !== options.traceId) continue;
        if (options.types?.length && !options.types.includes(event.type)) continue;
        if (options.since && event.timestamp < options.since) continue;
        if (options.until && event.timestamp > options.until) continue;

        events.push(event);
        if (options.limit && events.length >= options.limit) return events;
      }
    }
    return events;
  }

  async getTrace(traceId: string): Promise<TraceEvent[]> {
    return this.query({ traceId });
  }
}
