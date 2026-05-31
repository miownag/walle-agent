/**
 * ToolResultVault — offloads oversized tool outputs to disk.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  EVICTED_TOOL_RESULT_KIND,
  type EvictedToolResult,
  type EvictedToolResultMeta,
} from "./memory-types.js";

/** Options for preview construction. */
export interface ToolResultVaultOptions {
  dir: string;
  thresholdChars: number;
  previewHeadLines: number;
  previewTailLines: number;
}

const DEFAULTS: Omit<ToolResultVaultOptions, "dir"> = {
  thresholdChars: 20_000,
  previewHeadLines: 30,
  previewTailLines: 30,
};

export class ToolResultVault {
  readonly dir: string;
  readonly thresholdChars: number;
  readonly previewHeadLines: number;
  readonly previewTailLines: number;

  constructor(options: Partial<ToolResultVaultOptions> & { dir: string }) {
    this.dir = options.dir;
    this.thresholdChars = options.thresholdChars ?? DEFAULTS.thresholdChars;
    this.previewHeadLines = options.previewHeadLines ?? DEFAULTS.previewHeadLines;
    this.previewTailLines = options.previewTailLines ?? DEFAULTS.previewTailLines;
  }

  /**
   * Return true if `content` exceeds the threshold.
   */
  shouldEvict(content: string): boolean {
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
   * to put back inside the evicted ModelMessage.
   */
  async evict(params: {
    toolCallId: string;
    toolName: string;
    content: string;
    status?: string;
  }): Promise<EvictedToolResult> {
    const safeId = this.sanitize(params.toolCallId);
    await fs.mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `${safeId}.txt`);
    const metaFile = path.join(this.dir, `${safeId}.meta.json`);

    await fs.writeFile(file, params.content, "utf-8");

    const envelope: EvictedToolResult = {
      _kind: EVICTED_TOOL_RESULT_KIND,
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      path: file,
      size: params.content.length,
      preview: this.buildPreview(params.content),
      evictedAt: new Date().toISOString(),
    };

    const meta: EvictedToolResultMeta = { ...envelope, status: params.status as any };
    await fs.writeFile(metaFile, JSON.stringify(meta, null, 2));
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
