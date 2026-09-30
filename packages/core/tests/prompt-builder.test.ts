import { describe, expect, it } from "vitest";
import { PromptBuilder } from "../src/prompt-builder.js";
import type { AgentInput } from "../src/agent-config.js";
import type { ContentBlock, ModelMessage } from "../src/message.js";
import type { Attachment } from "../src/types.js";

function build(input: AgentInput, conversationHistory?: ModelMessage[]) {
  return new PromptBuilder().build({
    systemPrompt: "system",
    input,
    context: [],
    tools: [],
    conversationHistory,
  });
}

function currentUserBlocks(messages: ModelMessage[]): ContentBlock[] {
  const content = messages.at(-1)?.content;
  if (!Array.isArray(content)) throw new Error("expected content blocks");
  return content;
}

describe("PromptBuilder attachments", () => {
  it("preserves the original string shape when there are no attachments", () => {
    const messages = build({ content: "hello" });
    expect(messages.at(-1)).toEqual({ role: "user", content: "hello" });
  });

  it("encodes Buffer image data and keeps base64 only in the image block", () => {
    const data = Buffer.from([0, 1, 2, 3, 254, 255]);
    const encoded = data.toString("base64");
    const history: ModelMessage[] = [
      { role: "user", content: "prior" },
      { role: "assistant", content: "history" },
    ];
    const messages = build(
      {
        content: "inspect this image",
        attachments: [
          {
            type: "image",
            name: "capture.png",
            mimeType: "image/png",
            data,
          },
        ],
      },
      history,
    );
    const blocks = currentUserBlocks(messages);

    expect(blocks).toEqual([
      { type: "text", text: "inspect this image" },
      {
        type: "text",
        text: '[Attachment: type="image"; name="capture.png"; mime="image/png"]',
      },
      {
        type: "image",
        source: {
          type: "base64",
          mediaType: "image/png",
          data: encoded,
        },
      },
    ]);
    expect(JSON.stringify(messages.slice(0, -1))).not.toContain(encoded);
    expect(JSON.stringify(blocks.slice(0, -1))).not.toContain(encoded);
    expect(history).toEqual([
      { role: "user", content: "prior" },
      { role: "assistant", content: "history" },
    ]);
  });

  it("treats image strings as base64 and preserves existing content blocks", () => {
    const original: ContentBlock[] = [
      { type: "text", text: "existing text" },
      {
        type: "image",
        source: { type: "url", url: "https://example.com/existing.png" },
      },
    ];
    const canonical = Buffer.from("image bytes").toString("base64");
    const unpadded = canonical.replace(/=+$/, "");
    const messages = build({
      content: original,
      attachments: [
        {
          type: "image",
          name: "next.webp",
          mimeType: "IMAGE/WEBP",
          data: unpadded,
        },
      ],
    });
    const blocks = currentUserBlocks(messages);

    expect(blocks.slice(0, original.length)).toEqual(original);
    expect(blocks.at(-1)).toEqual({
      type: "image",
      source: {
        type: "base64",
        mediaType: "image/webp",
        data: canonical,
      },
    });
  });

  it("maps only HTTP(S) URL attachments to URL image blocks", () => {
    const blocks = currentUserBlocks(
      build({
        content: "remote",
        attachments: [
          {
            type: "url",
            name: "remote image",
            mimeType: "image/jpeg",
            data: "https://example.com/image.jpg?size=2",
          },
        ],
      }),
    );

    expect(blocks.at(-1)).toEqual({
      type: "image",
      source: { type: "url", url: "https://example.com/image.jpg?size=2" },
    });
    expect(blocks.at(-2)).toEqual({
      type: "text",
      text: '[Attachment: type="url"; name="remote image"; mime="image/jpeg"; url="https://example.com/image.jpg?size=2"]',
    });
  });

  it("describes file attachments without reading or embedding the file", () => {
    const path = "/definitely/not/read/architecture.pdf";
    const blocks = currentUserBlocks(
      build({
        content: "review this file",
        attachments: [
          {
            type: "file",
            name: "architecture.pdf",
            mimeType: "application/pdf",
            data: path,
          },
        ],
      }),
    );

    expect(blocks).toEqual([
      { type: "text", text: "review this file" },
      {
        type: "text",
        text: `[Attachment: type="file"; name="architecture.pdf"; mime="application/pdf"; path=${JSON.stringify(path)}]`,
      },
    ]);
    expect(blocks.some((block) => block.type === "image")).toBe(false);
  });

  it.each([
    {
      label: "non-image MIME",
      attachment: {
        type: "image",
        mimeType: "text/plain",
        data: "aGVsbG8=",
      },
      error: /mimeType must be a valid image/i,
    },
    {
      label: "invalid base64",
      attachment: {
        type: "image",
        mimeType: "image/png",
        data: "not!base64",
      },
      error: /valid base64/i,
    },
    {
      label: "empty image",
      attachment: {
        type: "image",
        mimeType: "image/png",
        data: Buffer.alloc(0),
      },
      error: /image data is empty/i,
    },
    {
      label: "unsafe URL scheme",
      attachment: {
        type: "url",
        mimeType: "image/png",
        data: "file:///tmp/image.png",
      },
      error: /HTTP or HTTPS/i,
    },
    {
      label: "malformed URL",
      attachment: {
        type: "url",
        data: "not a url",
      },
      error: /valid URL/i,
    },
    {
      label: "binary file data",
      attachment: {
        type: "file",
        name: "secret.bin",
        data: Buffer.from("do not stringify me"),
      },
      error: /path string/i,
    },
  ])(
    "rejects $label instead of silently emitting malformed blocks",
    ({ attachment, error }) => {
      expect(() =>
        build({
          content: "test",
          attachments: [attachment as Attachment],
        }),
      ).toThrow(error);
    },
  );
});
