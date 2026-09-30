import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { IconExternalLink } from "@tabler/icons-react";

import { cn } from "@/lib/utils";
import { MarkdownCodeBlock } from "./markdown-code-block";

interface MarkdownProps {
  children: string;
  className?: string;
  onOpenExternal?: (url: string) => void;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  return value as Record<string, unknown>;
}

function nodeText(value: unknown): string {
  const node = recordValue(value);
  if (!node) return "";
  if (typeof node.value === "string") return node.value;
  if (!Array.isArray(node.children)) return "";
  return node.children.map(nodeText).join("");
}

function codeBlockFromNode(
  value: unknown,
): { code: string; language?: string } | undefined {
  const pre = recordValue(value);
  if (!pre || !Array.isArray(pre.children)) return;
  const codeNode = pre.children.map(recordValue).find((child) => {
    return child?.type === "element" && child.tagName === "code";
  });
  if (!codeNode) return;
  const properties = recordValue(codeNode.properties);
  const classNames = Array.isArray(properties?.className)
    ? properties.className.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : typeof properties?.className === "string"
      ? [properties.className]
      : [];
  const language = classNames
    .map((className) => /^language-(.+)$/i.exec(className)?.[1])
    .find(Boolean);
  return {
    code: nodeText(codeNode).replace(/\n$/, ""),
    language,
  };
}

export function Markdown({
  children,
  className,
  onOpenExternal,
}: MarkdownProps) {
  return (
    <div
      className={cn("walle-markdown min-w-0 text-[13px] leading-6", className)}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href = "", children: linkChildren, ...props }) => (
            <a
              href={href}
              className="inline-flex items-baseline gap-0.5 text-[var(--info)] underline decoration-[var(--info)]/30 underline-offset-3 hover:decoration-[var(--info)]"
              onClick={(event) => {
                if (!onOpenExternal) return;
                event.preventDefault();
                onOpenExternal(href);
              }}
              {...props}
            >
              {linkChildren}
              {/^https?:/i.test(href) && (
                <IconExternalLink className="relative top-0.5 inline size-3" />
              )}
            </a>
          ),
          code: ({
            className: codeClassName,
            children: codeChildren,
            ...props
          }) => (
            <code
              className={cn(
                "rounded-[5px] border border-border/70 bg-muted/55 px-1 py-0.5 text-[0.9em]",
                codeClassName,
              )}
              {...props}
            >
              {codeChildren}
            </code>
          ),
          pre: ({ node, children: preChildren, ...props }) => {
            const codeBlock = codeBlockFromNode(node);
            return codeBlock ? (
              <MarkdownCodeBlock {...codeBlock} />
            ) : (
              <pre
                className="my-3 max-w-full overflow-x-auto rounded-lg border border-border/70 bg-[var(--code-bg)] p-3 text-[var(--code-font-size,12px)] leading-5"
                {...(props as ComponentPropsWithoutRef<"pre">)}
              >
                {preChildren}
              </pre>
            );
          },
          table: ({ children: tableChildren, ...props }) => (
            <div className="my-3 overflow-x-auto rounded-lg border">
              <table
                className="w-full border-collapse text-left text-xs"
                {...props}
              >
                {tableChildren}
              </table>
            </div>
          ),
          th: ({ children: cellChildren, ...props }) => (
            <th
              className="border-b bg-muted/50 px-2 py-1.5 font-medium"
              {...props}
            >
              {cellChildren}
            </th>
          ),
          td: ({ children: cellChildren, ...props }) => (
            <td
              className="border-b border-r px-2 py-1.5 last:border-r-0"
              {...props}
            >
              {cellChildren}
            </td>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
