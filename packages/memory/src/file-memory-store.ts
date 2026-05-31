/**
 * FileMemoryStore — JSONL-backed long-term memory store.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createReadStream, existsSync } from "node:fs";
import * as readline from "node:readline";
import { jaccard, keywordScore } from "./similarity.js";
import type { MemoryItem, MemoryQuery, MemoryScope } from "./memory-types.js";

export interface MemoryStore {
  init(): Promise<void>;
  put(item: MemoryItem): Promise<void>;
  get(id: string): Promise<MemoryItem | undefined>;
  update(id: string, patch: Partial<MemoryItem>): Promise<void>;
  delete(id: string): Promise<void>;
  search(query: MemoryQuery): Promise<MemoryItem[]>;
  list(options?: { scope?: MemoryScope; limit?: number; offset?: number }): Promise<MemoryItem[]>;
}

export class FileMemoryStore implements MemoryStore {
  private memories = new Map<string, MemoryItem>();
  private filePath: string;
  private initialized = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    if (existsSync(this.filePath)) {
      const rl = readline.createInterface({ input: createReadStream(this.filePath) });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line) as MemoryItem;
          this.memories.set(item.id, item);
        } catch {
          // skip malformed line
        }
      }
    }
    this.initialized = true;
  }

  async put(item: MemoryItem): Promise<void> {
    await this.init();
    this.memories.set(item.id, item);
    await fs.appendFile(this.filePath, JSON.stringify(item) + "\n");
  }

  async get(id: string): Promise<MemoryItem | undefined> {
    await this.init();
    return this.memories.get(id);
  }

  async update(id: string, patch: Partial<MemoryItem>): Promise<void> {
    await this.init();
    const existing = this.memories.get(id);
    if (!existing) return;
    const updated: MemoryItem = { ...existing, ...patch, id: existing.id };
    this.memories.set(id, updated);
    await this.rewrite();
  }

  async delete(id: string): Promise<void> {
    await this.init();
    this.memories.delete(id);
    await this.rewrite();
  }

  async search(query: MemoryQuery): Promise<MemoryItem[]> {
    await this.init();
    let items = [...this.memories.values()];

    if (query.scope) items = items.filter((i) => i.scope === query.scope);
    if (query.types?.length) items = items.filter((i) => query.types!.includes(i.type));
    if (query.userId) items = items.filter((i) => i.userId === query.userId);
    if (query.sessionId) items = items.filter((i) => i.sessionId === query.sessionId);

    if (query.text && query.text.trim()) {
      const q = query.text;
      items = items
        .map((item) => {
          const corpus = [item.content, ...(item.tags ?? [])].join(" ");
          const contentScore = keywordScore(q, corpus);
          const similarityScore = jaccard(q, corpus);
          const score = contentScore * 0.6 + similarityScore * 0.4;
          return { item, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.item);
    } else {
      // No query text: sort by createdAt desc
      items = items.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    }

    return items.slice(0, query.topK ?? 10);
  }

  async list(options?: {
    scope?: MemoryScope;
    limit?: number;
    offset?: number;
  }): Promise<MemoryItem[]> {
    await this.init();
    let items = [...this.memories.values()];
    if (options?.scope) items = items.filter((i) => i.scope === options.scope);
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 100;
    return items.slice(offset, offset + limit);
  }

  private async rewrite(): Promise<void> {
    const lines = [...this.memories.values()].map((i) => JSON.stringify(i)).join("\n");
    const payload = lines.length > 0 ? lines + "\n" : "";
    await fs.writeFile(this.filePath, payload);
  }
}
