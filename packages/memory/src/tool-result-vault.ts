/**
 * ToolResultVault — offloads (and indexes) tool outputs to disk.
 *
 * v0.1: this module evicted ONLY when an output exceeded `thresholdChars`.
 *       Vault was passive — it produced an envelope to embed in `messages.jsonl`,
 *       and rehydration happened only on cross-run history loading.
 *
 * v0.2 (this version): the vault becomes the backing store for the new
 *       turn-based "micro" context compression (see docs/21-context-compression.md).
 *       Two changes:
 *
 *       1. `thresholdChars` defaults to 0 ⇒ every tool output is persisted
 *          on disk so any future turn / `read_tool_result` call can read it back.
 *       2. New `index.jsonl` keeps a monotonic `idx` per `toolCallId` so
 *          placeholders can show stable "ToolResult #N" handles.
 *       3. `ensure(...)` is the new write-or-reuse entry point and `readSlice(...)`
 *          gives line-paginated access to stored outputs.
 *
 *       The legacy `evict()` method is preserved for backward compatibility
 *       with `MemoryPlugin.afterToolCall` — it now delegates to `ensure()`.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { existsSync, createReadStream } from "node:fs";
import * as readline from "node:readline";
import {
  EVICTED_TOOL_RESULT_KIND,
  type EvictedToolResult,
  type EvictedToolResultMeta,
} from "./memory-types.js";
import type { ToolCallRecord } from "@walle-agent/core";

/** Options for preview construction. */
export interface ToolResultVaultOptions {
  dir: string;
  thresholdChars: number;
  previewHeadLines: number;
  previewTailLines: number;
}

const DEFAULTS: Omit<ToolResultVaultOptions, "dir"> = {
  thresholdChars: 0,
  previewHeadLines: 10,
  previewTailLines: 10,
};

interface VaultIndexEntry {
  idx: number;
  toolCallId: string;
  toolName: string;
  ts: string;
  size: number;
  status?: ToolCallRecord["status"];
}

export interface ReadSliceResult {
  content: string;
  totalLines: number;
  truncated: boolean;
}

export class ToolResultVault {
  readonly dir: string;
  readonly thresholdChars: number;
  readonly previewHeadLines: number;
  readonly previewTailLines: number;

  private nextIdx = 1;
  /** In-memory cache of the persisted index for fast `idx` lookup. */
  private indexByCallId = new Map<string, VaultIndexEntry>();
  private indexLoaded = false;

  constructor(options: Partial<ToolResultVaultOptions> & { dir: string }) {
    this.dir = options.dir;
    this.thresholdChars = options.thresholdChars ?? DEFAULTS.thresholdChars;
    this.previewHeadLines = options.previewHeadLines ?? DEFAULTS.previewHeadLines;
    this.previewTailLines = options.previewTailLines ?? DEFAULTS.previewTailLines;
  }

  /**
   * Return true if `content` exceeds the threshold. Threshold of 0 means
   * "always evict to disk".
   */
  shouldEvict(content: string): boolean {
    if (this.thresholdChars <= 0) return true;
    return content.length > this.thresholdChars;
  }

  /**
   * Build a head/tail preview with an explicit "[N lines truncated]" marker.
   */
  buildPreview(content: string): string {
    const lines = content.split("\n");
    const head = this.previewHeadLines;
    const tail = this.previewTailLines;

    if (lines.length <= head + tail) return content;

    const headPart = lines.slice(0, head).join("\n");
    const tailPart = lines.slice(lines.length - tail).join("\n");
    const missing = lines.length - head - tail;
    return `${headPart}\n... [${missing} lines truncated] ...\n${tailPart}`;
  }

  /**
   * Persist `content` to `<dir>/<toolCallId>.txt` and return the envelope
   * to put back inside the evicted ModelMessage. Backward-compatible with
   * v0.1; new callers should prefer `ensure(...)` which exposes the `idx`.
   */
  async evict(params: {
    toolCallId: string;
    toolName: string;
    content: string;
    status?: string;
  }): Promise<EvictedToolResult> {
    const { idx: _idx, ...envelope } = await this.ensure({
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      content: params.content,
      status: params.status as ToolCallRecord["status"] | undefined,
    });
    void _idx;
    return envelope;
  }

  /**
   * Idempotent write-or-reuse. If a file for `toolCallId` already exists
   * (from a previous run / earlier turn), the existing `idx` is reused and
   * no rewrite happens. Otherwise the content is written, an entry is
   * appended to `index.jsonl`, and a fresh `idx` is allocated.
   */
  async ensure(params: {
    toolCallId: string;
    toolName: string;
    content: string;
    status?: ToolCallRecord["status"];
  }): Promise<EvictedToolResult & { idx: number }> {
    await this.loadIndex();

    const safeId = this.sanitize(params.toolCallId);
    const file = path.join(this.dir, `${safeId}.txt`);
    const metaFile = path.join(this.dir, `${safeId}.meta.json`);

    const existing = this.indexByCallId.get(params.toolCallId);
    if (existing && existsSync(file)) {
      const envelope: EvictedToolResult & { idx: number } = {
        idx: existing.idx,
        _kind: EVICTED_TOOL_RESULT_KIND,
        toolCallId: params.toolCallId,
        toolName: existing.toolName ?? params.toolName,
        path: file,
        size: existing.size,
        preview: this.buildPreview(params.content),
        evictedAt: existing.ts,
      };
      return envelope;
    }

    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(file, params.content, "utf-8");

    const idx = this.nextIdx++;
    const ts = new Date().toISOString();

    const envelope: EvictedToolResult & { idx: number } = {
      idx,
      _kind: EVICTED_TOOL_RESULT_KIND,
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      path: file,
      size: params.content.length,
      preview: this.buildPreview(params.content),
      evictedAt: ts,
    };

    const meta: EvictedToolResultMeta & { idx: number } = {
      ...envelope,
      status: params.status,
    };
    await fs.writeFile(metaFile, JSON.stringify(meta, null, 2));

    const indexEntry: VaultIndexEntry = {
      idx,
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      ts,
      size: params.content.length,
      status: params.status,
    };
    this.indexByCallId.set(params.toolCallId, indexEntry);
    await fs.appendFile(this.indexFile(), JSON.stringify(indexEntry) + "\n", "utf-8");

    return envelope;
  }

  /**
   * Read back the full content by id (used on cancel-resume).
   */
  async readFull(toolCallId: string): Promise<string | undefined> {
    const safeId = this.sanitize(toolCallId);
    const file = path.join(this.dir, `${safeId}.txt`);
    try {
      return await fs.readFile(file, "utf-8");
    } catch {
      return undefined;
    }
  }

  /**
   * Line-paginated read of stored content. `offset` is 0-based; `limit`
   * caps how many lines are returned. `truncated` is true iff the result
   * is shorter than `totalLines - offset` worth of lines.
   */
  async readSlice(
    toolCallId: string,
    options: { offset?: number; limit?: number } = {},
  ): Promise<ReadSliceResult | undefined> {
    const full = await this.readFull(toolCallId);
    if (full == null) return undefined;
    const lines = full.split("\n");
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const limit = Math.max(1, Math.floor(options.limit ?? 200));
    const slice = lines.slice(offset, offset + limit);
    return {
      content: slice.join("\n"),
      totalLines: lines.length,
      truncated: offset + slice.length < lines.length,
    };
  }

  /**
   * Best-effort read of envelope by id. Prefer decoding from message content,
   * this only exists for manual inspection.
   */
  async readEnvelope(toolCallId: string): Promise<EvictedToolResultMeta | undefined> {
    const safeId = this.sanitize(toolCallId);
    const metaFile = path.join(this.dir, `${safeId}.meta.json`);
    try {
      const raw = await fs.readFile(metaFile, "utf-8");
      return JSON.parse(raw) as EvictedToolResultMeta;
    } catch {
      return undefined;
    }
  }

  /** Return the current monotonic idx for `toolCallId`, or `undefined`. */
  async getIdx(toolCallId: string): Promise<number | undefined> {
    await this.loadIndex();
    return this.indexByCallId.get(toolCallId)?.idx;
  }

  /**
   * Format the envelope into a prompt-ready summary string.
   * This is what the LLM sees on *future* turns for an evicted tool result.
   */
  formatSummary(envelope: EvictedToolResult): string {
    const { path: p, toolCallId, toolName, size, evictedAt, preview } = envelope;
    return (
      `Tool result too long. You can read ${p} if needed.\n` +
      `(toolCallId=${toolCallId}, tool=${toolName}, size=${size} chars, evictedAt=${evictedAt})\n\n` +
      preview
    );
  }

  // ─── internals ──────────────────────────────────────────────────

  private indexFile(): string {
    return path.join(this.dir, "index.jsonl");
  }

  private async loadIndex(): Promise<void> {
    if (this.indexLoaded) return;
    this.indexLoaded = true;
    const file = this.indexFile();
    if (!existsSync(file)) return;

    const rl = readline.createInterface({ input: createReadStream(file) });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as VaultIndexEntry;
        this.indexByCallId.set(entry.toolCallId, entry);
        if (entry.idx >= this.nextIdx) this.nextIdx = entry.idx + 1;
      } catch {
        // skip malformed
      }
    }
  }

  private sanitize(id: string): string {
    // Keep filenames strictly alphanumeric + `_`/`-` so no path traversal or
    // accidental hidden-file dots can slip through.
    const cleaned = id.replace(/[^A-Za-z0-9_-]/g, "_");
    return cleaned.length > 0 ? cleaned : "unnamed";
  }
}

/**
 * Try to decode an evicted envelope out of a ModelMessage.content string.
 * Returns the envelope if the content is valid JSON with `_kind === walle.evicted-tool-result`.
 */
export function tryDecodeEviction(content: unknown): EvictedToolResult | undefined {
  if (typeof content !== "string") return undefined;
  if (!content.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(content);
    if (parsed && parsed._kind === EVICTED_TOOL_RESULT_KIND) {
      return parsed as EvictedToolResult;
    }
  } catch {
    // not JSON
  }
  return undefined;
}
