import { mergeAttributes, Node, type Editor } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type ReactNodeViewProps,
} from "@tiptap/react";

import { cn } from "@/lib/utils";
import type { UserMessagePart } from "@shared/contracts";
import { FileReferenceChip } from "./file-reference-chip";

export const FILE_REFERENCE_NODE_NAME = "fileReference";

export interface FileReferenceAttrs {
  name: string;
  relativePath: string;
  /** Canonical path returned by main. It is editor-only and never rendered or persisted. */
  absolutePath: string;
}

export type EditorMessagePart =
  | { type: "text"; text: string }
  | ({ type: "file" } & FileReferenceAttrs);

function FileReferenceNodeView({ node, selected }: ReactNodeViewProps) {
  const attrs = node.attrs as FileReferenceAttrs;

  return (
    <NodeViewWrapper
      as="span"
      data-file-reference-node=""
      className={cn(
        "inline rounded-md",
        selected && "ring-2 ring-ring/35 ring-offset-1 ring-offset-background",
      )}
    >
      <FileReferenceChip
        name={attrs.name}
        relativePath={attrs.relativePath}
      />
    </NodeViewWrapper>
  );
}

export const FileReferenceNode = Node.create({
  name: FILE_REFERENCE_NODE_NAME,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      name: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-file-name") ?? "",
        renderHTML: (attributes) => ({
          "data-file-name": String(attributes.name ?? ""),
        }),
      },
      relativePath: {
        default: "",
        parseHTML: (element) =>
          element.getAttribute("data-relative-path") ?? "",
        renderHTML: (attributes) => ({
          "data-relative-path": String(attributes.relativePath ?? ""),
        }),
      },
      absolutePath: {
        default: "",
        rendered: false,
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-file-reference]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const relativePath = String(node.attrs.relativePath ?? "");
    return [
      "span",
      mergeAttributes(HTMLAttributes, { "data-file-reference": "" }),
      `@[${relativePath}]`,
    ];
  },

  renderText({ node }) {
    return `@[${String(node.attrs.relativePath ?? "")}]`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(FileReferenceNodeView);
  },
});

function appendText(parts: EditorMessagePart[], text: string): void {
  if (!text) return;
  const previous = parts.at(-1);
  if (previous?.type === "text") {
    previous.text += text;
    return;
  }
  parts.push({ type: "text", text });
}

/** Extracts text and file atoms in document order without coupling persistence to Tiptap JSON. */
export function extractEditorMessageParts(editor: Editor): EditorMessagePart[] {
  const parts: EditorMessagePart[] = [];
  let firstParagraph = true;

  editor.state.doc.descendants((node) => {
    if (node.type.name === "paragraph") {
      if (!firstParagraph) appendText(parts, "\n");
      firstParagraph = false;
      return true;
    }
    if (node.type.name === "hardBreak") {
      appendText(parts, "\n");
      return false;
    }
    if (node.isText) {
      appendText(parts, node.text ?? "");
      return false;
    }
    if (node.type.name === FILE_REFERENCE_NODE_NAME) {
      const attrs = node.attrs as FileReferenceAttrs;
      parts.push({
        type: "file",
        name: attrs.name,
        relativePath: attrs.relativePath,
        absolutePath: attrs.absolutePath,
      });
      return false;
    }
    return true;
  });

  return parts;
}

export function trimEditorMessageParts(
  input: EditorMessagePart[],
): EditorMessagePart[] {
  const parts = input.map((part) => ({ ...part }));
  while (parts[0]?.type === "text") {
    parts[0].text = parts[0].text.trimStart();
    if (parts[0].text) break;
    parts.shift();
  }
  while (parts.at(-1)?.type === "text") {
    const last = parts.at(-1);
    if (!last || last.type !== "text") break;
    last.text = last.text.trimEnd();
    if (last.text) break;
    parts.pop();
  }
  return parts;
}

export function toUserMessageParts(
  parts: EditorMessagePart[],
): UserMessagePart[] {
  return parts.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : {
          type: "file",
          name: part.name,
          relativePath: part.relativePath,
        },
  );
}

export function serializeEditorMessageParts(
  parts: EditorMessagePart[],
  target: "display" | "model",
): string {
  return parts
    .map((part) => {
      if (part.type === "text") return part.text;
      if (target === "model") return part.absolutePath || part.relativePath;
      return `@[${part.relativePath}]`;
    })
    .join("");
}

export function insertFileReference(
  editor: Editor,
  range: { from: number; to: number },
  attrs: FileReferenceAttrs,
): boolean {
  return editor
    .chain()
    .focus()
    .insertContentAt(
      range,
      [
        { type: FILE_REFERENCE_NODE_NAME, attrs },
        { type: "text", text: " " },
      ],
      { updateSelection: true },
    )
    .run();
}
