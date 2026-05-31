import { describe, it, expect } from "vitest";
import { InMemoryTraceStore } from "../src/in-memory-trace-store.js";
import type { TraceEvent } from "../src/trace-types.js";

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

describe("InMemoryTraceStore", () => {
  it("write + getTrace round-trip", async () => {
    const store = new InMemoryTraceStore();
    await store.write(ev({ traceId: "a", type: "run_start" }));
    await store.write(ev({ traceId: "a", type: "run_end" }));
    await store.write(ev({ traceId: "b", type: "run_start" }));

    const t = await store.getTrace("a");
    expect(t).toHaveLength(2);
    expect(t[0].type).toBe("run_start");
    expect(t[1].type).toBe("run_end");
  });

  it("query filters by traceId / types / since / until / limit", async () => {
    const store = new InMemoryTraceStore();
    await store.write(ev({ traceId: "x", type: "run_start", timestamp: "2024-01-01T00:00:00.000Z" }));
    await store.write(ev({ traceId: "x", type: "tool_call_end", timestamp: "2024-02-01T00:00:00.000Z" }));
    await store.write(ev({ traceId: "y", type: "run_end", timestamp: "2024-03-01T00:00:00.000Z" }));

    expect(await store.query({ traceId: "x" })).toHaveLength(2);
    expect(await store.query({ types: ["run_end"] })).toHaveLength(1);
    expect(await store.query({ since: "2024-02-01T00:00:00.000Z" })).toHaveLength(2);
    expect(await store.query({ until: "2024-01-31T23:59:59.000Z" })).toHaveLength(1);
    expect(await store.query({ limit: 1 })).toHaveLength(1);
  });

  it("evicts oldest when maxSize is exceeded", async () => {
    const store = new InMemoryTraceStore({ maxSize: 3 });
    for (let i = 0; i < 5; i++) {
      await store.write(ev({ id: `e${i}`, traceId: String(i) }));
    }
    expect(store.size()).toBe(3);
    const all = await store.query({});
    expect(all.map((e) => e.id)).toEqual(["e2", "e3", "e4"]);
  });

  it("query results are decoupled copies", async () => {
    const store = new InMemoryTraceStore();
    await store.write(ev({ traceId: "z" }));
    const out = await store.query({});
    out.push(ev({ traceId: "ghost" }));
    expect(store.size()).toBe(1);
  });

  it("dispose() clears", async () => {
    const store = new InMemoryTraceStore();
    await store.write(ev());
    await store.dispose();
    expect(store.size()).toBe(0);
  });
});
