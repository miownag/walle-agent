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

interface AttachmentMetadata {
  name?: string;
  mimeType?: string;
}

/** Raw image bytes or a base64-encoded image string. `mimeType` is required. */
export interface ImageAttachment extends AttachmentMetadata {
  type: "image";
  mimeType: string;
  data: string | Buffer;
}

/** HTTP(S) image reference. The URL is never fetched by PromptBuilder. */
export interface UrlAttachment extends AttachmentMetadata {
  type: "url";
  data: string;
}

/** Local file reference. PromptBuilder describes the path but never reads it. */
export interface FileAttachment extends AttachmentMetadata {
  type: "file";
  data: string;
}

/** Attachment for multimodal input. */
export type Attachment = ImageAttachment | UrlAttachment | FileAttachment;
