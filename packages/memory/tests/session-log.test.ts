import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionLog } from "../src/session-log.js";

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "walle-session-"));
}

describe("SessionLog", () => {
  let dir: string;
  let log: SessionLog;

  beforeEach(async () => {
    dir = await tmp();
    log = new SessionLog(dir);
  });

  it("round-trips messages in insertion order", async () => {
    await log.appendMessage("s1", "r1", 0, { role: "user", content: "hi" });
    await log.appendMessage("s1", "r1", 1, { role: "assistant", content: "hello" });
    await log.flush();

    const records = await log.readMessages("s1");
    expect(records).toHaveLength(2);
    expect(records[0].message.content).toBe("hi");
    expect(records[1].message.content).toBe("hello");
    expect(records[0].turn).toBe(0);
    expect(records[1].turn).toBe(1);
  });

  it("serializes interleaved appends even when fired in parallel", async () => {
    await Promise.all([
      log.appendMessage("s1", "r1", 0, { role: "user", content: "a" }),
      log.appendMessage("s1", "r1", 1, { role: "assistant", content: "b" }),
      log.appendMessage("s1", "r1", 2, { role: "user", content: "c" }),
    ]);
    await log.flush();

    const records = await log.readMessages("s1");
    expect(records).toHaveLength(3);
    // Order should reflect queue order (first-queued first).
    expect(records.map((r) => r.message.content)).toEqual(["a", "b", "c"]);
  });

  it("tracks run starts + ends and returns last prior run", async () => {
    await log.appendRunStart("s1", "r1");
    await log.appendRunEnd("s1", "r1", { endAt: new Date().toISOString(), status: "completed" });
    await log.appendRunStart("s1", "r2");
    await log.appendRunEnd("s1", "r2", {
      endAt: new Date().toISOString(),
      status: "user-cancelled",
    });
    await log.appendRunStart("s1", "r3");
    await log.flush();

    const lastPrior = await log.lastRun("s1", "r3");
    expect(lastPrior?.runId).toBe("r2");
    expect(lastPrior?.status).toBe("user-cancelled");
  });

  it("returns undefined for missing session", async () => {
    expect(await log.readMessages("nope")).toEqual([]);
    expect(await log.readRuns("nope")).toEqual([]);
    expect(await log.lastRun("nope")).toBeUndefined();
  });

  it("skips malformed trailing line", async () => {
    await log.appendMessage("s1", "r1", 0, { role: "user", content: "ok" });
    await log.flush();
    const file = path.join(dir, "s1", "messages.jsonl");
    await fs.appendFile(file, "this is not json\n");
    const records = await log.readMessages("s1");
    expect(records).toHaveLength(1);
  });
});
