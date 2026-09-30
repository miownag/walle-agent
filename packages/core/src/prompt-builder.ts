/**
 * PromptBuilder — assembles the final message list for LLM calls.
 */

import type { ContentBlock, ModelMessage, TextBlock } from "./message.js";
import type { AgentInput } from "./agent-config.js";
import type { ContextItem } from "./events.js";
import type { Tool } from "./tool.js";
import type { Attachment } from "./types.js";

export interface PromptBuildOptions {
  systemPrompt?: string;
  input: AgentInput;
  context: ContextItem[];
  tools: Tool[];
  conversationHistory?: ModelMessage[];
}

const MIME_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
const IMAGE_MIME_PATTERN = /^image\/[a-z0-9!#$&^_.+-]+$/i;
const BASE64_PATTERN =
  /^(?:[a-z0-9+/]{4})*(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?$/i;

function attachmentError(index: number, detail: string): TypeError {
  return new TypeError(`Invalid attachment at index ${index}: ${detail}`);
}

function optionalMetadata(
  value: unknown,
  field: "name" | "mimeType",
  index: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw attachmentError(index, `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) throw attachmentError(index, `${field} cannot be empty`);
  return trimmed;
}

function imageMimeType(attachment: Attachment, index: number): string {
  const mimeType = optionalMetadata(attachment.mimeType, "mimeType", index);
  if (!mimeType || !IMAGE_MIME_PATTERN.test(mimeType)) {
    throw attachmentError(index, "mimeType must be a valid image/* type");
  }
  return mimeType.toLowerCase();
}

function encodeImageData(data: unknown, index: number): string {
  if (Buffer.isBuffer(data)) {
    if (data.length === 0) throw attachmentError(index, "image data is empty");
    return data.toString("base64");
  }
  if (typeof data !== "string") {
    throw attachmentError(
      index,
      "image data must be a Buffer or base64 string",
    );
  }

  const compact = data.replace(/\s/g, "");
  if (!compact || compact.length % 4 === 1) {
    throw attachmentError(index, "image data is not valid base64");
  }
  const padded = compact.padEnd(
    compact.length + ((4 - (compact.length % 4)) % 4),
    "=",
  );
  if (!BASE64_PATTERN.test(padded)) {
    throw attachmentError(index, "image data is not valid base64");
  }
  const decoded = Buffer.from(padded, "base64");
  if (!decoded.length || decoded.toString("base64") !== padded) {
    throw attachmentError(index, "image data is not canonical base64");
  }
  return padded;
}

function traceBlock(parts: Array<[string, string | undefined]>): TextBlock {
  const text = parts
    .filter((part): part is [string, string] => part[1] !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("; ");
  return { type: "text", text: `[Attachment: ${text}]` };
}

function attachmentBlocks(
  attachment: Attachment,
  index: number,
): ContentBlock[] {
  if (!attachment || typeof attachment !== "object") {
    throw attachmentError(index, "attachment must be an object");
  }
  const name = optionalMetadata(attachment.name, "name", index);

  if (attachment.type === "image") {
    const mimeType = imageMimeType(attachment, index);
    const data = encodeImageData(attachment.data, index);
    return [
      traceBlock([
        ["type", "image"],
        ["name", name],
        ["mime", mimeType],
      ]),
      {
        type: "image",
        source: { type: "base64", mediaType: mimeType, data },
      },
    ];
  }

  if (attachment.type === "url") {
    const mimeType = optionalMetadata(attachment.mimeType, "mimeType", index);
    if (mimeType && !IMAGE_MIME_PATTERN.test(mimeType)) {
      throw attachmentError(index, "URL mimeType must be a valid image/* type");
    }
    if (typeof attachment.data !== "string" || !attachment.data.trim()) {
      throw attachmentError(index, "URL data must be a non-empty string");
    }
    let url: URL;
    try {
      url = new URL(attachment.data.trim());
    } catch {
      throw attachmentError(index, "URL data is not a valid URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw attachmentError(index, "URL protocol must be HTTP or HTTPS");
    }
    return [
      traceBlock([
        ["type", "url"],
        ["name", name],
        ["mime", mimeType?.toLowerCase()],
        ["url", url.toString()],
      ]),
      { type: "image", source: { type: "url", url: url.toString() } },
    ];
  }

  if (attachment.type === "file") {
    const mimeType = optionalMetadata(attachment.mimeType, "mimeType", index);
    if (mimeType && !MIME_PATTERN.test(mimeType)) {
      throw attachmentError(index, "file mimeType is invalid");
    }
    if (typeof attachment.data !== "string" || !attachment.data.trim()) {
      throw attachmentError(index, "file data must be a non-empty path string");
    }
    return [
      traceBlock([
        ["type", "file"],
        ["name", name],
        ["mime", mimeType?.toLowerCase()],
        ["path", attachment.data],
      ]),
    ];
  }

  throw attachmentError(index, "unsupported attachment type");
}

function buildUserContent(input: AgentInput): string | ContentBlock[] {
  const attachments = input.attachments ?? [];
  if (attachments.length === 0) return input.content;

  const blocks: ContentBlock[] =
    typeof input.content === "string"
      ? [{ type: "text", text: input.content }]
      : [...input.content];
  attachments.forEach((attachment, index) => {
    blocks.push(...attachmentBlocks(attachment, index));
  });
  return blocks;
}

export class PromptBuilder {
  /**
   * Build the message list for an LLM call.
   */
  build(options: PromptBuildOptions): ModelMessage[] {
    const messages: ModelMessage[] = [];

    // 1. System message
    const systemParts: string[] = [];
    if (options.systemPrompt) {
      systemParts.push(options.systemPrompt);
    }

    // Inject context items into system prompt
    if (options.context.length > 0) {
      const contextSection = options.context
        .map((item) => `[${item.source}]\n${item.content}`)
        .join("\n\n");
      systemParts.push(`\n<context>\n${contextSection}\n</context>`);
    }

    if (systemParts.length > 0) {
      messages.push({
        role: "system",
        content: systemParts.join("\n"),
      });
    }

    // 2. Conversation history
    if (options.conversationHistory) {
      messages.push(...options.conversationHistory);
    }

    // 3. User input
    messages.push({
      role: "user",
      content: buildUserContent(options.input),
    });

    return messages;
  }
}
