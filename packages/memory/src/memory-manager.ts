/**
 * MemoryManager — high-level API over the long-term MemoryStore.
 */

import { jaccard } from "./similarity.js";
import { FileMemoryStore, type MemoryStore } from "./file-memory-store.js";
import type {
  MemoryItem,
  MemoryQuery,
  MemoryRetrieveOptions,
  MemoryScope,
  MemoryType,
} from "./memory-types.js";

export interface MemoryManagerConfig {
  store?: MemoryStore;
  /** If `store` is not supplied, a FileMemoryStore pointing at this path is used. */
  filePath?: string;
  dedupThreshold?: number;
  defaultTopK?: number;
}

/** Input accepted by `remember()` — caller supplies the content, we fill the rest. */
export interface RememberInput {
  content: string;
  type?: MemoryType;
  scope?: MemoryScope;
  tags?: string[];
  importance?: number;
  confidence?: number;
  userId?: string;
  sessionId?: string;
  source?: MemoryItem["source"];
}

export class MemoryManager {
  readonly store: MemoryStore;
  private dedupThreshold: number;
  private defaultTopK: number;
  private initPromise: Promise<void> | undefined;

  constructor(config: MemoryManagerConfig) {
    if (config.store) {
      this.store = config.store;
    } else {
      if (!config.filePath) {
        throw new Error("MemoryManager: either `store` or `filePath` is required");
      }
      this.store = new FileMemoryStore(config.filePath);
    }
    this.dedupThreshold = config.dedupThreshold ?? 0.8;
    this.defaultTopK = config.defaultTopK ?? 8;
  }

  async init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.store.init();
    await this.initPromise;
  }

  async remember(input: RememberInput): Promise<MemoryItem> {
    await this.init();

    const now = new Date().toISOString();
    const candidate: MemoryItem = {
      id: newId(),
      scope: input.scope ?? "long",
      type: input.type ?? "fact",
      content: input.content,
      importance: clamp01(input.importance ?? 0.5),
      confidence: clamp01(input.confidence ?? 0.8),
      userId: input.userId,
      sessionId: input.sessionId,
      tags: input.tags,
      createdAt: now,
      source: input.source,
    };

    // Deduplicate against same scope + type.
    const duplicates = await this.store.search({
      text: candidate.content,
      scope: candidate.scope,
      types: [candidate.type],
      topK: 5,
    });

    const hit = duplicates.find((d) => jaccard(d.content, candidate.content) >= this.dedupThreshold);

    if (hit) {
      const merged: Partial<MemoryItem> = {
        content: candidate.content.length > hit.content.length ? candidate.content : hit.content,
        confidence: Math.max(hit.confidence, candidate.confidence),
        importance: Math.max(hit.importance, candidate.importance),
        tags: dedupStrings([...(hit.tags ?? []), ...(candidate.tags ?? [])]),
        updatedAt: now,
      };
      await this.store.update(hit.id, merged);
      return { ...hit, ...merged };
    }

    await this.store.put(candidate);
    return candidate;
  }

  async retrieve(query: string, options?: MemoryRetrieveOptions): Promise<MemoryItem[]> {
    await this.init();

    const longTopK = options?.longTopK ?? this.defaultTopK;
    const results = await this.store.search({
      text: query,
      scope: "long",
      userId: options?.userId,
      sessionId: options?.sessionId,
      topK: longTopK,
    });
    return results;
  }

  async forget(id: string): Promise<boolean> {
    await this.init();
    const existing = await this.store.get(id);
    if (!existing) return false;
    await this.store.delete(id);
    return true;
  }

  async list(options?: {
    scope?: MemoryScope;
    limit?: number;
    offset?: number;
  }): Promise<MemoryItem[]> {
    await this.init();
    return this.store.list(options);
  }

  async search(query: MemoryQuery): Promise<MemoryItem[]> {
    await this.init();
    return this.store.search(query);
  }
}

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function dedupStrings(xs: string[]): string[] {
  return [...new Set(xs)];
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `mem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
