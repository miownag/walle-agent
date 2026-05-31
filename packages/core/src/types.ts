/**
 * Shared utility types for Walle Agent SDK.
 */

/** JSON Schema type (subset used for tool parameters) */
export type JSONSchema = {
  type?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  [key: string]: unknown;
};

/** Generic record type */
export type AnyRecord = Record<string, unknown>;

/** Token usage information */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Attachment for multimodal input */
export interface Attachment {
  type: "file" | "image" | "url";
  name?: string;
  mimeType?: string;
  data: string | Buffer;
}
