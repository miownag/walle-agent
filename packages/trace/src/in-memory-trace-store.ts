/**
 * InMemoryTraceStore — bounded ring buffer for tests / ephemeral inspection.
 *
 * Drops oldest events when `maxSize` is reached. Query/getTrace return
 * defensive copies so callers can mutate freely.
 */

import type {
  TraceEvent,
  TraceQuery,
  TraceStore,
} from "./trace-types.js";

export interface InMemoryTraceStoreOptions {
  /** Cap on retained events. Defaults to 10000. */
  maxSize?: number;
}

export class InMemoryTraceStore implements TraceStore {
  private events: TraceEvent[] = [];
  private readonly maxSize: number;

  constructor(options: InMemoryTraceStoreOptions = {}) {
    this.maxSize = options.maxSize ?? 10_000;
  }

  async write(event: TraceEvent): Promise<void> {
    this.events.push(event);
    if (this.events.length > this.maxSize) {
      this.events = this.events.slice(-this.maxSize);
    }
  }

  async query(options: TraceQuery): Promise<TraceEvent[]> {
    let results = [...this.events];
    if (options.traceId) results = results.filter((e) => e.traceId === options.traceId);
    if (options.types?.length) results = results.filter((e) => options.types!.includes(e.type));
    if (options.since) results = results.filter((e) => e.timestamp >= options.since!);
    if (options.until) results = results.filter((e) => e.timestamp <= options.until!);
    if (options.limit) results = results.slice(0, options.limit);
    return results;
  }

  async getTrace(traceId: string): Promise<TraceEvent[]> {
    return this.events.filter((e) => e.traceId === traceId);
  }

  /** Read access for tests. */
  size(): number {
    return this.events.length;
  }

  async dispose(): Promise<void> {
    this.events = [];
  }
}
