import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileMemoryStore } from "../src/file-memory-store.js";
import type { MemoryItem } from "../src/memory-types.js";

async function tmpFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "walle-mem-"));
  return path.join(dir, "mem.jsonl");
}

function makeItem(over: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: over.id ?? `id-${Math.random().toString(36).slice(2)}`,
    scope: over.scope ?? "long",
    type: over.type ?? "fact",
    content: over.content ?? "sample content",
    importance: over.importance ?? 0.5,
    confidence: over.confidence ?? 0.8,
    createdAt: over.createdAt ?? new Date().toISOString(),
    ...over,
  };
}

describe("FileMemoryStore", () => {
  let file: string;
  beforeEach(async () => {
    file = await tmpFile();
  });

  it("put → get → list round-trip survives re-instantiation", async () => {
    const store1 = new FileMemoryStore(file);
    await store1.init();
    const a = makeItem({ content: "alpha" });
    const b = makeItem({ content: "beta" });
    await store1.put(a);
    await store1.put(b);

    const store2 = new FileMemoryStore(file);
    await store2.init();
    expect((await store2.get(a.id))?.content).toBe("alpha");
    expect((await store2.list()).length).toBe(2);
  });

  it("update rewrites the file and delete removes", async () => {
    const store = new FileMemoryStore(file);
    await store.init();
    const a = makeItem({ content: "original" });
    await store.put(a);
    await store.update(a.id, { content: "updated" });
    expect((await store.get(a.id))?.content).toBe("updated");

    const raw1 = await fs.readFile(file, "utf-8");
    expect(raw1).toContain("updated");
    expect(raw1).not.toContain("original");

    await store.delete(a.id);
    expect(await store.get(a.id)).toBeUndefined();
    const raw2 = await fs.readFile(file, "utf-8");
    expect(raw2).toBe("");
  });

  it("search ranks by keyword overlap and honours scope/type filters", async () => {
    const store = new FileMemoryStore(file);
    await store.init();
    await store.put(makeItem({ content: "user prefers pnpm", type: "preference" }));
    await store.put(makeItem({ content: "project uses typescript", type: "fact" }));
    await store.put(makeItem({ content: "favourite colour is blue" }));

    const res = await store.search({ text: "pnpm typescript", topK: 10 });
    expect(res.length).toBeGreaterThanOrEqual(2);
    expect(["user prefers pnpm", "project uses typescript"]).toContain(res[0].content);

    const prefOnly = await store.search({
      text: "pnpm typescript",
      types: ["preference"],
      topK: 10,
    });
    expect(prefOnly).toHaveLength(1);
    expect(prefOnly[0].type).toBe("preference");
  });

  it("empty query returns items by recency", async () => {
    const store = new FileMemoryStore(file);
    await store.init();
    await store.put(makeItem({ content: "first", createdAt: "2026-01-01T00:00:00.000Z" }));
    await store.put(makeItem({ content: "second", createdAt: "2026-05-01T00:00:00.000Z" }));
    const res = await store.search({ topK: 10 });
    expect(res[0].content).toBe("second");
  });
});
