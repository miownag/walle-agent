/**
 * SimpleRAGPlugin — file-backed keyword retriever.
 *
 * No vector store, no embedding cost. Loads files matching `patterns` under
 * `docsPath` at install time, chunks them by character window, scores each
 * chunk against the query by simple word-overlap, and injects the top hits
 * via the `collect_context` event (priority blended with score).
 *
 * Sufficient for small knowledge bases (READMEs, notes, runbooks). For
 * production-scale RAG with embeddings, ship a separate plugin
 * (e.g. `@walle-agent/rag-qdrant`) implementing the same `RAGPlugin` shape.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentContext } from "@walle-agent/core";
import type {
  RAGChunk,
  RAGContext,
  RAGDocument,
  RAGDocumentInfo,
  RAGPlugin,
  RAGRetrieveRequest,
  SimpleRAGConfig,
} from "./rag-types.js";

export class SimpleRAGPlugin implements RAGPlugin {
  readonly name = "rag";
  readonly version = "0.1.0";

  private chunks: RAGChunk[] = [];
  private installed = false;

  constructor(private readonly config: SimpleRAGConfig) {
    if (!config.docsPath) {
      throw new Error("SimpleRAGPlugin: config.docsPath is required");
    }
  }

  // ─── lifecycle ──────────────────────────────────────────────────

  async install(ctx: AgentContext): Promise<void> {
    await this.loadDocs();
    this.installed = true;

    if (this.config.injectContext === false) return;

    ctx.events.on("collect_context", async ({ query, items }) => {
      const results = await this.retrieve({
        query,
        topK: this.config.topK ?? 5,
        minScore: this.config.minScore ?? 0.1,
      });
      for (const r of results) {
        items.push({
          source: "rag",
          // 40 base + up to 30 from score; matches the spec's blended priority.
          priority: 40 + (r.score ?? 0) * 30,
          content: `[Knowledge] ${r.content}\nSource: ${r.source ?? "unknown"}`,
          estimatedTokens: estimateTokens(r.content),
          metadata: { id: r.id, score: r.score, ...(r.metadata ?? {}) },
        });
      }
    });
  }

  // ─── public API ─────────────────────────────────────────────────

  async retrieve(request: RAGRetrieveRequest): Promise<RAGContext[]> {
    const queryWords = tokenize(request.query);
    if (queryWords.length === 0) return [];

    const minScore = request.minScore ?? 0;
    const topK = request.topK ?? 5;

    const scored = this.chunks
      .map((chunk) => {
        const words = tokenize(chunk.content);
        const hits = queryWords.filter((qw) => words.some((w) => w.includes(qw))).length;
        const score = hits / queryWords.length;
        return { chunk, score };
      })
      .filter((x) => x.score > minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return scored.map(({ chunk, score }) => ({
      id: chunk.id,
      content: chunk.content,
      score,
      source: chunk.source,
      metadata: chunk.metadata,
    }));
  }

  async ingest(documents: RAGDocument[]): Promise<void> {
    for (const doc of documents) {
      const baseId = doc.id ?? newId();
      const source = (doc.metadata?.source as string | undefined) ?? doc.id;
      const pieces = this.splitIntoChunks(doc.content);
      for (let i = 0; i < pieces.length; i++) {
        this.chunks.push({
          id: `${baseId}#${i}`,
          content: pieces[i],
          source,
          metadata: doc.metadata,
        });
      }
    }
  }

  async delete(ids: string[]): Promise<void> {
    const set = new Set(ids);
    this.chunks = this.chunks.filter((c) => !set.has(c.id) && !set.has(c.id.split("#")[0]));
  }

  async list(): Promise<RAGDocumentInfo[]> {
    // Group chunks by their pre-`#` document id.
    const seen = new Map<string, RAGDocumentInfo>();
    for (const c of this.chunks) {
      const docId = c.id.includes("#") ? c.id.slice(0, c.id.indexOf("#")) : c.id;
      if (!seen.has(docId)) {
        seen.set(docId, {
          id: docId,
          source: c.source,
          metadata: c.metadata,
        });
      }
    }
    return [...seen.values()];
  }

  /** Read access for tests / debugging. */
  getChunks(): readonly RAGChunk[] {
    return this.chunks;
  }

  /** Whether `install()` has run (for tests / introspection). */
  isInstalled(): boolean {
    return this.installed;
  }

  // ─── internals ──────────────────────────────────────────────────

  private async loadDocs(): Promise<void> {
    const root = this.config.docsPath;
    const patterns = this.config.patterns ?? ["**/*.md", "**/*.txt"];
    const allowedExts = new Set(
      patterns
        .map((p) => {
          const m = p.match(/\.([a-zA-Z0-9]+)$/);
          return m ? `.${m[1].toLowerCase()}` : null;
        })
        .filter((x): x is string => Boolean(x)),
    );

    let entries: string[];
    try {
      entries = (await fs.readdir(root, { recursive: true })) as string[];
    } catch (err: any) {
      if (err.code === "ENOENT") return; // Empty knowledge base — silently skip.
      throw err;
    }

    for (const rel of entries) {
      const ext = path.extname(rel).toLowerCase();
      if (allowedExts.size > 0 && !allowedExts.has(ext)) continue;

      const full = path.join(root, rel);
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue; // Race / broken symlink.
      }
      if (!stat.isFile()) continue;

      let content: string;
      try {
        content = await fs.readFile(full, "utf8");
      } catch {
        continue;
      }

      const pieces = this.splitIntoChunks(content);
      for (let i = 0; i < pieces.length; i++) {
        this.chunks.push({
          id: `${rel}#${i}`,
          content: pieces[i],
          source: rel,
          metadata: { path: full },
        });
      }
    }
  }

  private splitIntoChunks(text: string): string[] {
    const size = this.config.chunkSize ?? 500;
    const overlapRaw = this.config.chunkOverlap ?? 100;
    const overlap = Math.min(overlapRaw, size - 1); // Keep stride positive.
    const stride = Math.max(1, size - overlap);
    const chunks: string[] = [];

    if (text.length === 0) return chunks;

    for (let i = 0; i < text.length; i += stride) {
      chunks.push(text.slice(i, i + size));
      if (i + size >= text.length) break;
    }
    return chunks;
  }
}

// ─── helpers ──────────────────────────────────────────────────────

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9_一-鿿]+/)
    .filter((w) => w.length > 0);
}

function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `rag-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
