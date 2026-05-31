import { describe, it, expect } from "vitest";
import { Blackboard } from "../src/blackboard.js";

describe("Blackboard", () => {
  it("post() adds a timestamped entry; getEntries() returns a defensive copy", async () => {
    const bb = new Blackboard();
    await bb.post({ agent: "A", content: "hello", round: 0 });

    const entries = bb.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ agent: "A", content: "hello", round: 0 });
    expect(typeof entries[0].timestamp).toBe("string");
    // Defensive copy: mutating the returned array does not affect internals.
    entries.push({ agent: "X", content: "x", round: 9, timestamp: "z" });
    expect(bb.getEntries()).toHaveLength(1);
  });

  it("renderForAgent returns the bare task when empty", () => {
    const bb = new Blackboard();
    expect(bb.renderForAgent("do thing")).toBe("do thing");
  });

  it("renderForAgent prepends prior entries with a Your-Turn anchor", async () => {
    const bb = new Blackboard();
    await bb.post({ agent: "A", content: "first", round: 0 });
    await bb.post({ agent: "B", content: "second", round: 1 });
    const out = bb.renderForAgent("the task");
    expect(out).toContain("Task: the task");
    expect(out).toContain("[A @ Round 0]: first");
    expect(out).toContain("[B @ Round 1]: second");
    expect(out).toContain("## Your Turn:");
  });

  it("renderFinal joins entries by `---`, preserving post order", async () => {
    const bb = new Blackboard();
    await bb.post({ agent: "A", content: "1", round: 0 });
    await bb.post({ agent: "B", content: "2", round: 1 });
    await bb.post({ agent: "C", content: "3", round: 2 });
    const out = bb.renderFinal();
    expect(out).toContain("## A\n1");
    expect(out).toContain("## B\n2");
    expect(out).toContain("## C\n3");
    expect(out.split("---")).toHaveLength(3);
    // Order preserved
    expect(out.indexOf("## A")).toBeLessThan(out.indexOf("## B"));
    expect(out.indexOf("## B")).toBeLessThan(out.indexOf("## C"));
  });
});
