import { describe, it, expect } from "vitest";
import { HookManager } from "../src/hooks.js";

describe("HookManager", () => {
  it("should register and emit hooks", async () => {
    const manager = new HookManager();
    const received: any[] = [];

    manager.register("beforeModelCall", (payload) => {
      received.push(payload);
    });

    await manager.emit("beforeModelCall", { messages: [{ role: "user", content: "hi" }] });

    expect(received).toHaveLength(1);
    expect(received[0].messages[0].content).toBe("hi");
  });

  it("should execute handlers in parallel", async () => {
    const manager = new HookManager();
    const order: number[] = [];

    manager.register("beforeModelCall", async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
    });

    manager.register("beforeModelCall", async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push(2);
    });

    await manager.emit("beforeModelCall", { messages: [] });

    // Both should have completed (order may vary since parallel)
    expect(order).toHaveLength(2);
    expect(order).toContain(1);
    expect(order).toContain(2);
  });

  it("should not throw on handler error (logs instead)", async () => {
    const manager = new HookManager();

    manager.register("beforeModelCall", () => {
      throw new Error("hook error");
    });

    // Should not throw
    await manager.emit("beforeModelCall", { messages: [] });
  });

  it("should support unsubscribe", async () => {
    const manager = new HookManager();
    let count = 0;

    const unsub = manager.register("afterModelCall", () => { count++; });
    await manager.emit("afterModelCall", { message: { role: "assistant", content: "hi" } });
    expect(count).toBe(1);

    unsub();
    await manager.emit("afterModelCall", { message: { role: "assistant", content: "hi" } });
    expect(count).toBe(1);
  });

  it("should registerAll from object", async () => {
    const manager = new HookManager();
    let started = false;
    let ended = false;

    manager.registerAll({
      beforeModelCall: () => { started = true; },
      afterModelCall: () => { ended = true; },
    });

    await manager.emit("beforeModelCall", { messages: [] });
    await manager.emit("afterModelCall", { message: { role: "assistant", content: "" } });

    expect(started).toBe(true);
    expect(ended).toBe(true);
  });
});
