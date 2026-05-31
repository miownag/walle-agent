import { describe, it, expect } from "vitest";
import { EventBus } from "../src/events.js";

describe("EventBus", () => {
  it("should register and emit events", async () => {
    const bus = new EventBus();
    const received: any[] = [];

    bus.on("run_start", (payload) => {
      received.push(payload);
    });

    await bus.emit("run_start", { input: { content: "hello" }, runId: "r1" });

    expect(received).toHaveLength(1);
    expect(received[0].input.content).toBe("hello");
    expect(received[0].runId).toBe("r1");
  });

  it("should support multiple listeners", async () => {
    const bus = new EventBus();
    let count = 0;

    bus.on("run_end", () => { count++; });
    bus.on("run_end", () => { count++; });

    await bus.emit("run_end", { messages: [], runId: "r1", status: "completed" });

    expect(count).toBe(2);
  });

  it("should return unsubscribe function", async () => {
    const bus = new EventBus();
    let count = 0;

    const unsub = bus.on("run_end", () => { count++; });
    await bus.emit("run_end", { messages: [], runId: "r1", status: "completed" });
    expect(count).toBe(1);

    unsub();
    await bus.emit("run_end", { messages: [], runId: "r1", status: "completed" });
    expect(count).toBe(1);
  });

  it("should handle async handlers", async () => {
    const bus = new EventBus();
    let resolved = false;

    bus.on("run_start", async () => {
      await new Promise((r) => setTimeout(r, 10));
      resolved = true;
    });

    await bus.emit("run_start", { input: { content: "test" }, runId: "r1" });
    expect(resolved).toBe(true);
  });

  it("collect_messages: plugins can push prior history", async () => {
    const bus = new EventBus();

    bus.on("collect_messages", ({ sessionId, into }) => {
      if (sessionId === "s1") {
        into.push({ role: "user", content: "earlier" });
        into.push({ role: "assistant", content: "earlier reply" });
      }
    });

    const history: any[] = [];
    await bus.emit("collect_messages", { sessionId: "s1", into: history });
    expect(history).toHaveLength(2);
    expect(history[0].content).toBe("earlier");

    const empty: any[] = [];
    await bus.emit("collect_messages", { sessionId: "nope", into: empty });
    expect(empty).toHaveLength(0);
  });
});
