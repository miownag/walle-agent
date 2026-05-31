import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SimpleRAGPlugin } from "../src/simple-rag-plugin.js";
import type { ContextItem } from "@walle-agent/core";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "walle-rag-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeFile(rel: string, content: string): Promise<void> {
  const full = path.join(dir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf8");
}

function fakeCollectContextCtx() {
  type Listener = (payload: { query: string; items: ContextItem[] }) => Promise<void> | void;
  const listeners: Listener[] = [];
  return {
    events: {
      on: (event: string, handler: Listener) => {
        if (event === "collect_context") listeners.push(handler);
      },
    },
    fire: async (query: string): Promise<ContextItem[]> => {
      const items: ContextItem[] = [];
      for (const l of listeners) {
        await l({ query, items });
      }
      return items;
    },
  };
}

describe("SimpleRAGPlugin constructor", () => {
  it("throws when docsPath is missing", () => {
    expect(() => new SimpleRAGPlugin({} as any)).toThrow(/docsPath/);
  });
});

describe("SimpleRAGPlugin loadDocs", () => {
  it("loads matching files and chunks them by chunkSize/overlap", async () => {
    await writeFile("a.md", "alpha beta gamma delta");
    await writeFile("nested/b.md", "epsilon zeta eta theta");
    await writeFile("ignore.json", "not loaded");
    const plugin = new SimpleRAGPlugin({ docsPath: dir, chunkSize: 100 });
    const ctx = fakeCollectContextCtx();
    await plugin.install(ctx as any);

    const chunks = plugin.getChunks();
    expect(chunks.some((c) => c.source === "a.md")).toBe(true);
    expect(chunks.some((c) => c.source === path.join("nested", "b.md"))).toBe(true);
    expect(chunks.every((c) => c.source !== "ignore.json")).toBe(true);
  });

  it("supports custom patterns by file extension", async () => {
    await writeFile("a.md", "skip me");
    await writeFile("b.txt", "include me");
    const plugin = new SimpleRAGPlugin({ docsPath: dir, patterns: ["**/*.txt"] });
    await plugin.install(fakeCollectContextCtx() as any);
    const sources = plugin.getChunks().map((c) => c.source).sort();
    expect(sources).toEqual(["b.txt"]);
  });

  it("silently no-ops when docsPath does not exist", async () => {
    const ghost = path.join(dir, "ghost-dir");
    const plugin = new SimpleRAGPlugin({ docsPath: ghost });
    await plugin.install(fakeCollectContextCtx() as any);
    expect(plugin.getChunks()).toHaveLength(0);
    expect(plugin.isInstalled()).toBe(true);
  });

  it("chunks overflow content with overlap", async () => {
    const text = "x".repeat(450);
    await writeFile("big.md", text);
    const plugin = new SimpleRAGPlugin({
      docsPath: dir,
      chunkSize: 100,
      chunkOverlap: 20,
    });
    await plugin.install(fakeCollectContextCtx() as any);
    const chunks = plugin.getChunks();
    // 450 chars, stride 80 → 6 chunks (i=0..400 step 80 → 0,80,160,240,320,400; 400+100=500≥450 stops)
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    expect(chunks.length).toBeLessThanOrEqual(7);
    expect(chunks[0].content.length).toBe(100);
  });
});

describe("SimpleRAGPlugin.retrieve", () => {
  it("returns chunks scored by query word overlap, sorted desc", async () => {
    const plugin = new SimpleRAGPlugin({ docsPath: dir });
    await plugin.install(fakeCollectContextCtx() as any);
    await plugin.ingest!([
      { id: "doc1", content: "deployment uses kubernetes and helm", metadata: { source: "deploy.md" } },
      { id: "doc2", content: "the cat sat on the mat", metadata: { source: "cat.md" } },
      { id: "doc3", content: "kubernetes deployment notes", metadata: { source: "k8s.md" } },
    ]);

    const hits = await plugin.retrieve({ query: "kubernetes deployment", topK: 5 });
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score!);
    expect(hits[0].content).toMatch(/kubernetes/i);
    // The cat doc should be filtered out by minScore.
    expect(hits.find((h) => h.content.includes("cat"))).toBeUndefined();
  });

  it("honours topK", async () => {
    const plugin = new SimpleRAGPlugin({ docsPath: dir });
    await plugin.install(fakeCollectContextCtx() as any);
    await plugin.ingest!([
      { id: "1", content: "alpha alpha alpha" },
      { id: "2", content: "alpha alpha" },
      { id: "3", content: "alpha" },
    ]);
    const hits = await plugin.retrieve({ query: "alpha", topK: 2 });
    expect(hits).toHaveLength(2);
  });

  it("honours minScore", async () => {
    const plugin = new SimpleRAGPlugin({ docsPath: dir });
    await plugin.install(fakeCollectContextCtx() as any);
    await plugin.ingest!([
      { id: "1", content: "exact match foo bar" },
      { id: "2", content: "no overlap whatsoever" },
    ]);
    const hits = await plugin.retrieve({ query: "foo", minScore: 0.5 });
    expect(hits.every((h) => (h.score ?? 0) > 0.5)).toBe(true);
  });

  it("returns [] when query is empty / unhelpful", async () => {
    const plugin = new SimpleRAGPlugin({ docsPath: dir });
    await plugin.install(fakeCollectContextCtx() as any);
    await plugin.ingest!([{ id: "1", content: "anything" }]);
    expect(await plugin.retrieve({ query: "" })).toEqual([]);
    expect(await plugin.retrieve({ query: "    " })).toEqual([]);
  });
});

describe("SimpleRAGPlugin.collect_context integration", () => {
  it("auto-injects retrieval results when injectContext is true (default)", async () => {
    await writeFile("k.md", "kubernetes deployment uses helm");
    const plugin = new SimpleRAGPlugin({ docsPath: dir, chunkSize: 1000 });
    const ctx = fakeCollectContextCtx();
    await plugin.install(ctx as any);

    const items = await ctx.fire("kubernetes deployment");
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].source).toBe("rag");
    expect(items[0].content).toContain("[Knowledge]");
    expect(items[0].priority).toBeGreaterThanOrEqual(40);
    expect(items[0].priority).toBeLessThanOrEqual(70);
    expect(typeof items[0].estimatedTokens).toBe("number");
  });

  it("does NOT subscribe when injectContext is false", async () => {
    await writeFile("k.md", "alpha");
    const plugin = new SimpleRAGPlugin({ docsPath: dir, injectContext: false });
    const ctx = fakeCollectContextCtx();
    await plugin.install(ctx as any);
    const items = await ctx.fire("alpha");
    expect(items).toEqual([]);
  });
});

describe("SimpleRAGPlugin.ingest / delete / list", () => {
  it("ingest splits a long document into multiple chunks with #N suffix ids", async () => {
    const plugin = new SimpleRAGPlugin({
      docsPath: dir,
      chunkSize: 50,
      chunkOverlap: 0,
    });
    await plugin.install(fakeCollectContextCtx() as any);
    await plugin.ingest!([{ id: "long", content: "x".repeat(120) }]);
    const ids = plugin.getChunks().map((c) => c.id);
    expect(ids.every((id) => id.startsWith("long#"))).toBe(true);
    expect(ids.length).toBeGreaterThanOrEqual(2);
  });

  it("delete removes by chunk id and by parent doc id", async () => {
    const plugin = new SimpleRAGPlugin({ docsPath: dir });
    await plugin.install(fakeCollectContextCtx() as any);
    await plugin.ingest!([
      { id: "doc1", content: "one" },
      { id: "doc2", content: "two" },
    ]);
    await plugin.delete!(["doc1"]);
    expect(plugin.getChunks().some((c) => c.id.startsWith("doc1#"))).toBe(false);
    expect(plugin.getChunks().some((c) => c.id.startsWith("doc2#"))).toBe(true);
  });

  it("list returns one entry per parent document id", async () => {
    const plugin = new SimpleRAGPlugin({ docsPath: dir });
    await plugin.install(fakeCollectContextCtx() as any);
    await plugin.ingest!([
      { id: "a", content: "x".repeat(2000), metadata: { source: "a.md" } },
      { id: "b", content: "y", metadata: { source: "b.md" } },
    ]);
    const docs = await plugin.list!();
    const ids = docs.map((d) => d.id).sort();
    expect(ids).toEqual(["a", "b"]);
  });
});
