import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryManager } from "../src/memory-manager.js";

async function tmpFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "walle-mgr-"));
  return path.join(dir, "mem.jsonl");
}

describe("MemoryManager", () => {
  let file: string;
  beforeEach(async () => {
    file = await tmpFile();
  });

  it("creates an item when no near-duplicate exists", async () => {
    const m = new MemoryManager({ filePath: file });
    await m.init();
    const item = await m.remember({ content: "user prefers typescript over javascript" });
    expect(item.id).toBeTruthy();
    expect((await m.list()).length).toBe(1);
  });

  it("merges near-duplicates and bumps confidence", async () => {
    const m = new MemoryManager({ filePath: file, dedupThreshold: 0.5 });
    await m.init();
    const first = await m.remember({
      content: "user prefers typescript over javascript",
      confidence: 0.6,
    });
    const second = await m.remember({
      content: "user prefers typescript over javascript strongly",
      confidence: 0.9,
    });

    const all = await m.list();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(first.id);
    expect(all[0].confidence).toBe(0.9);
    expect(all[0].updatedAt).toBeTruthy();
    expect(second.id).toBe(first.id);
  });

  it("retrieve returns top-K scored by relevance", async () => {
    const m = new MemoryManager({ filePath: file });
    await m.init();
    await m.remember({ content: "user prefers pnpm package manager" });
    await m.remember({ content: "project uses typescript" });
    await m.remember({ content: "favourite food is pizza" });

    const res = await m.retrieve("which package manager?", { longTopK: 2 });
    expect(res.length).toBeGreaterThanOrEqual(1);
    expect(res[0].content).toContain("pnpm");
  });

  it("forget removes items", async () => {
    const m = new MemoryManager({ filePath: file });
    const item = await m.remember({ content: "one" });
    expect(await m.forget(item.id)).toBe(true);
    expect(await m.forget("nonexistent")).toBe(false);
    expect(await m.list()).toHaveLength(0);
  });
});
