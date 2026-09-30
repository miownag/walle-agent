import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { IconLoader2 } from "@tabler/icons-react";

import { cn } from "@/lib/utils";
import {
  highlightSource,
  languageForPreview,
  type HighlightedSource,
  type HighlightToken,
  type PreviewColorMode,
} from "./syntax-highlighter";

interface HighlightedCodeProps {
  content: string;
  languageHint?: string;
  loadingFallback?: "indicator" | "plain";
  relativePath: string;
}

function tokenStyle(token: HighlightToken) {
  const decorations = [
    token.fontStyle !== undefined && (token.fontStyle & 4) !== 0
      ? "underline"
      : "",
    token.fontStyle !== undefined && (token.fontStyle & 8) !== 0
      ? "line-through"
      : "",
  ].filter(Boolean);

  return {
    backgroundColor: token.backgroundColor,
    color: token.color,
    fontStyle:
      token.fontStyle !== undefined && (token.fontStyle & 1) !== 0
        ? "italic"
        : undefined,
    fontWeight:
      token.fontStyle !== undefined && (token.fontStyle & 2) !== 0
        ? 700
        : undefined,
    textDecoration: decorations.length ? decorations.join(" ") : undefined,
  } as const;
}

function PlainCode({
  content,
  status,
}: {
  content: string;
  status: "plain" | "fallback";
}) {
  return (
    <pre
      className="m-0 min-h-full min-w-max bg-[var(--code-bg)] p-3 text-[var(--code-font-size,12px)] leading-5 text-foreground/88"
      data-highlight-status={status}
    >
      <code>{content}</code>
    </pre>
  );
}

function TokenizedCode({ source }: { source: HighlightedSource }) {
  return (
    <pre
      className="m-0 min-h-full min-w-max p-3 text-[var(--code-font-size,12px)] leading-5"
      data-highlight-language={source.language}
      data-highlight-status="ready"
      data-highlight-theme={source.theme}
      style={{ backgroundColor: source.background, color: source.foreground }}
    >
      <code>
        {source.lines.map((line, lineIndex) => (
          <Fragment key={lineIndex}>
            {line.map((token, tokenIndex) => (
              <span
                key={`${lineIndex}:${tokenIndex}`}
                style={tokenStyle(token)}
              >
                {token.content}
              </span>
            ))}
            {lineIndex < source.lines.length - 1 ? "\n" : null}
          </Fragment>
        ))}
      </code>
    </pre>
  );
}

function currentColorMode(resolvedTheme: string | undefined): PreviewColorMode {
  if (resolvedTheme === "dark") return "dark";
  if (resolvedTheme === "light") return "light";
  return typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
    ? "dark"
    : "light";
}

export function HighlightedCode({
  content,
  languageHint,
  loadingFallback = "indicator",
  relativePath,
}: HighlightedCodeProps) {
  const { resolvedTheme } = useTheme();
  const colorMode = currentColorMode(resolvedTheme);
  const language = useMemo(
    () => languageForPreview(relativePath, languageHint),
    [languageHint, relativePath],
  );
  const [source, setSource] = useState<HighlightedSource | null>(null);
  const [failed, setFailed] = useState(false);
  const requestSequence = useRef(0);

  useEffect(() => {
    const sequence = ++requestSequence.current;
    setSource(null);
    setFailed(false);
    if (!language) return;

    void highlightSource(content, language, colorMode).then(
      (nextSource) => {
        if (sequence === requestSequence.current) setSource(nextSource);
      },
      () => {
        if (sequence === requestSequence.current) setFailed(true);
      },
    );

    return () => {
      if (sequence === requestSequence.current) requestSequence.current++;
    };
  }, [colorMode, content, language]);

  if (!language) return <PlainCode content={content} status="plain" />;
  if (failed) return <PlainCode content={content} status="fallback" />;
  if (source) return <TokenizedCode source={source} />;
  if (loadingFallback === "plain")
    return <PlainCode content={content} status="plain" />;

  return (
    <div
      className={cn(
        "flex min-h-full min-w-full items-center justify-center gap-2 bg-[var(--code-bg)] px-4",
        "text-[11px] text-muted-foreground",
      )}
      data-highlight-status="loading"
    >
      <IconLoader2 className="size-3.5 animate-spin" /> Highlighting {language}…
    </div>
  );
}
