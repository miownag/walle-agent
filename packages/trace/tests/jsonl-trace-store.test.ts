import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { JSONLTraceStore } from "../src/jsonl-trace-store.js";
import type { TraceEvent } from "../src/trace-types.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "walle-trace-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function ev(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    id: overrides.id ?? `id-${Math.random()}`,
    traceId: overrides.traceId ?? "t1",
    type: overrides.type ?? "run_start",
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    data: overrides.data ?? {},
    ...overrides,
  };
}

describe("JSONLTraceStore", () => {
  it("write creates a file per UTC date and appends one line per event", async () => {
    const store = new JSONLTraceStore(dir);
    await store.write(ev({ traceId: "a", timestamp: "2024-01-15T10:00:00.000Z" }));
    await store.write(ev({ traceId: "a", timestamp: "2024-01-15T11:00:00.000Z" }));
    await store.write(ev({ traceId: "b", timestamp: "2024-01-16T08:00:00.000Z" }));

    const files = (await fs.readdir(dir)).sort();
    expect(files).toEqual(["2024-01-15.jsonl", "2024-01-16.jsonl"]);

    const day1 = await fs.readFile(path.join(dir, "2024-01-15.jsonl"), "utf8");
    expect(day1.split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("query returns [] when directory does not exist", async () => {
    const store = new JSONLTraceStore(path.join(dir, "ghost"));
    expect(await store.query({})).toEqual([]);
    expect(await store.getTrace("x")).toEqual([]);
  });

  it("query honours traceId/types/since/until/limit filters", async () => {
    const store = new JSONLTraceStore(dir);
    await store.write(ev({ traceId: "x", type: "run_start", timestamp: "2024-01-01T00:00:00.000Z" }));
    await store.write(ev({ traceId: "x", type: "tool_call_end", timestamp: "2024-02-01T00:00:00.000Z" }));
    await store.write(ev({ traceId: "y", type: "run_end", timestamp: "2024-03-01T00:00:00.000Z" }));

    expect(await store.query({ traceId: "x" })).toHaveLength(2);
    expect(await store.query({ types: ["run_end"] })).toHaveLength(1);
    expect(await store.query({ since: "2024-02-01T00:00:00.000Z" })).toHaveLength(2);
    expect(await store.query({ until: "2024-01-31T23:59:59.000Z" })).toHaveLength(1);
    expect(await store.query({ limit: 1 })).toHaveLength(1);
  });

  it("walks files in reverse-chronological order so limit returns most recent first", async () => {
    const store = new JSONLTraceStore(dir);
    await store.write(ev({ id: "old", timestamp: "2024-01-01T00:00:00.000Z" }));
    await store.write(ev({ id: "new", timestamp: "2024-12-31T00:00:00.000Z" }));
    const out = await store.query({ limit: 1 });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("new");
  });

  it("ignores malformed lines silently", async () => {
    const store = new JSONLTraceStore(dir);
    const filePath = path.join(dir, "2024-01-15.jsonl");
    await fs.writeFile(filePath, "garbage\n", "utf8");
    await store.write(ev({ id: "good", timestamp: "2024-01-15T10:00:00.000Z" }));
    const out = await store.query({});
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("good");
  });
});
