import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EventBus, AgentContextImpl } from "@walle-agent/core";
import type { ToolCallRecord, ModelMessage } from "@walle-agent/core";
import { TracePlugin } from "../src/trace-plugin.js";
import { InMemoryTraceStore } from "../src/in-memory-trace-store.js";
import type { TraceStore } from "../src/trace-types.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "walle-trace-plugin-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Minimal AgentContext that the plugin actually exercises (just the EventBus). */
function fakeCtx(events: EventBus): AgentContextImpl {
  return {
    events,
    config: {} as any,
    agent: {} as any,
    registerTool: () => {},
    registerHook: () => {},
    registerMiddleware: () => {},
    getPlugin: () => undefined,
  } as unknown as AgentContextImpl;
}

describe("TracePlugin store selection", () => {
  it("defaults to JSONL store at ./.walle/traces", async () => {
    const plugin = new TracePlugin({ storePath: dir });
    await plugin.install(fakeCtx(new EventBus()));
    expect(plugin.getStore()).toBeDefined();
    expect(plugin.getStore().constructor.name).toBe("JSONLTraceStore");
  });

  it("store: 'memory' selects InMemoryTraceStore", async () => {
    const plugin = new TracePlugin({ store: "memory" });
    await plugin.install(fakeCtx(new EventBus()));
    expect(plugin.getStore()).toBeInstanceOf(InMemoryTraceStore);
  });

  it("customStore wins over store/storePath", async () => {
    const custom: TraceStore = {
      write: vi.fn(async () => {}),
      query: vi.fn(async () => []),
      getTrace: vi.fn(async () => []),
    };
    const plugin = new TracePlugin({ store: "memory", customStore: custom });
    await plugin.install(fakeCtx(new EventBus()));
    expect(plugin.getStore()).toBe(custom);
  });
});

describe("TracePlugin event recording", () => {
  it("records run_start with a fresh traceId; subsequent events share that traceId", async () => {
    const events = new EventBus();
    const plugin = new TracePlugin({ store: "memory" });
    await plugin.install(fakeCtx(events));

    await events.emit("run_start", {
      input: { content: "hi" },
      runId: "r1",
      sessionId: "s1",
    });
    await events.emit("model_call_start", { messages: [{ role: "user", content: "hi" }] });
    await events.emit("run_end", {
      messages: [{ role: "assistant", content: "ok" }] as ModelMessage[],
      runId: "r1",
      sessionId: "s1",
      status: "completed",
    });

    const all = await plugin.getStore().query({});
    expect(all).toHaveLength(3);
    const traceIds = new Set(all.map((e) => e.traceId));
    expect(traceIds.size).toBe(1);
    expect(plugin.getCurrentTraceId()).toBe([...traceIds][0]);
  });

  it("redacts content by default, includes it when recordContent: true", async () => {
    const events = new EventBus();
    const plugin = new TracePlugin({ store: "memory" });
    await plugin.install(fakeCtx(events));

    await events.emit("run_start", { input: { content: "secret" }, runId: "r" });
    const [r1] = await plugin.getStore().query({ types: ["run_start"] });
    expect(r1.data.input).toBe("[redacted]");

    const events2 = new EventBus();
    const plugin2 = new TracePlugin({ store: "memory", recordContent: true });
    await plugin2.install(fakeCtx(events2));
    await events2.emit("run_start", { input: { content: "secret" }, runId: "r" });
    const [r2] = await plugin2.getStore().query({ types: ["run_start"] });
    expect(r2.data.input).toBe("secret");
  });

  it("records tool_call_start and tool_call_end with name/status/durationMs", async () => {
    const events = new EventBus();
    const plugin = new TracePlugin({ store: "memory", recordContent: true });
    await plugin.install(fakeCtx(events));

    await events.emit("run_start", { input: { content: "x" }, runId: "r" });
    await events.emit("tool_call_start", {
      call: { id: "c1", name: "echo", arguments: { msg: "hi" } },
    });
    const rec: ToolCallRecord = {
      id: "c1",
      name: "echo",
      input: { msg: "hi" },
      output: "hi",
      status: "success",
      durationMs: 42,
    };
    await events.emit("tool_call_end", { record: rec });

    const starts = await plugin.getStore().query({ types: ["tool_call_start"] });
    const ends = await plugin.getStore().query({ types: ["tool_call_end"] });
    expect(starts[0].data).toMatchObject({ name: "echo", arguments: { msg: "hi" }, callId: "c1" });
    expect(ends[0].data).toMatchObject({ name: "echo", status: "success", durationMs: 42 });
    expect(ends[0].durationMs).toBe(42);
  });

  it("records context_collect with item count and sources, redacting query by default", async () => {
    const events = new EventBus();
    const plugin = new TracePlugin({ store: "memory" });
    await plugin.install(fakeCtx(events));

    await events.emit("run_start", { input: { content: "x" }, runId: "r" });
    await events.emit("collect_context", {
      query: "secret query",
      items: [
        { source: "memory", priority: 50, content: "..." },
        { source: "rag", priority: 60, content: "..." },
      ],
    });

    const [c] = await plugin.getStore().query({ types: ["context_collect"] });
    expect(c.data.itemCount).toBe(2);
    expect(c.data.sources).toEqual(["memory", "rag"]);
    expect(c.data.query).toBe("[redacted]");
  });

  it("sampleRate < 1 randomly drops events", async () => {
    const rand = vi.spyOn(Math, "random").mockReturnValue(0.99);
    const events = new EventBus();
    const plugin = new TracePlugin({ store: "memory", sampleRate: 0.1 });
    await plugin.install(fakeCtx(events));

    await events.emit("run_start", { input: { content: "x" }, runId: "r" });
    await events.emit("model_call_start", { messages: [] });

    expect((await plugin.getStore().query({})).length).toBe(0);
    rand.mockRestore();
  });

  it("never throws when the underlying store fails (logs and continues)", async () => {
    const events = new EventBus();
    const failing: TraceStore = {
      write: async () => {
        throw new Error("boom");
      },
      query: async () => [],
      getTrace: async () => [],
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const plugin = new TracePlugin({ customStore: failing });
    await plugin.install(fakeCtx(events));

    await expect(
      events.emit("run_start", { input: { content: "x" }, runId: "r" }),
    ).resolves.not.toThrow();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("TracePlugin lifecycle", () => {
  it("dispose() forwards to store.dispose()", async () => {
    const dispose = vi.fn(async () => {});
    const custom: TraceStore = {
      write: async () => {},
      query: async () => [],
      getTrace: async () => [],
      dispose,
    };
    const plugin = new TracePlugin({ customStore: custom });
    await plugin.install(fakeCtx(new EventBus()));
    await plugin.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
