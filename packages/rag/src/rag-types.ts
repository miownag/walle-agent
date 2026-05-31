/**
 * Public types for `@walle-agent/rag`.
 *
 * `RAGPlugin` is just a `WallePlugin` augmented with a `retrieve()` method
 * (and optional `ingest`/`delete`/`list`). External vector backends
 * (`@walle-agent/rag-qdrant`, etc.) implement this same shape.
 */

import type { WallePlugin } from "@walle-agent/core";

export interface RAGRetrieveRequest {
  /** User query; whatever heuristic (keyword, vector, hybrid) the backend uses. */
  query: string;
  /** Cap returned hits. Default backend-specific. */
  topK?: number;
  /** Backend-specific structured filter (e.g. metadata equality). */
  filters?: Record<string, unknown>;
  /** Drop hits below this score. Backend-specific scale. */
  minScore?: number;
}

export interface RAGContext {
  id: string;
  content: string;
  /** Backend-specific score, typically 0..1. */
  score?: number;
  /** Origin (file path, URL, etc.). */
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface RAGDocument {
  id?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface RAGDocumentInfo {
  id: string;
  source?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface RAGPlugin extends WallePlugin {
  retrieve(request: RAGRetrieveRequest): Promise<RAGContext[]>;
  ingest?(documents: RAGDocument[]): Promise<void>;
  delete?(ids: string[]): Promise<void>;
  list?(): Promise<RAGDocumentInfo[]>;
}

// ─── SimpleRAG-specific ─────────────────────────────────────────────

export interface SimpleRAGConfig {
  /** Directory to load documents from. */
  docsPath: string;
  /**
   * Filename patterns. Currently restricted to `**\/*.<ext>` — only the
   * extension matters (suffix match). Default: `["**\/*.md", "**\/*.txt"]`.
   */
  patterns?: string[];
  /** Character chunk size. Default 500. */
  chunkSize?: number;
  /** Overlap between adjacent chunks. Default 100. */
  chunkOverlap?: number;
  /**
   * Top-K cap when injecting via `collect_context`. Default 5.
   * Per-call overrides via `retrieve({ topK })` still win.
   */
  topK?: number;
  /** Drop hits below this score during `collect_context`. Default 0.1. */
  minScore?: number;
  /**
   * If `true`, register a `collect_context` listener that auto-injects RAG
   * results into the prompt. Default `true`. Set to `false` for callers
   * that only want to invoke `retrieve()` manually.
   */
  injectContext?: boolean;
}

/** Internal: an indexed chunk waiting to be retrieved. */
export interface RAGChunk {
  id: string;
  content: string;
  source?: string;
  metadata?: Record<string, unknown>;
}
