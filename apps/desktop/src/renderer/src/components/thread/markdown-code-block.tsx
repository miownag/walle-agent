import { useMemo } from "react";

import { HighlightedCode } from "@/components/dock/highlighted-code";
import { languageForPreview } from "@/components/dock/syntax-highlighter";
import { CopyButton } from "./copy-button";

interface MarkdownCodeBlockProps {
  code: string;
  language?: string;
}

export function MarkdownCodeBlock({ code, language }: MarkdownCodeBlockProps) {
  const normalizedLanguage = useMemo(
    () => languageForPreview("", language),
    [language],
  );
  const languageLabel = normalizedLanguage ?? language ?? "plain text";

  return (
    <div className="group/code my-3 min-w-0 overflow-hidden rounded-lg border border-border/55 bg-[var(--code-bg)] shadow-[0_1px_2px_rgba(0,0,0,0.025)]">
      <div className="flex h-8 items-center border-b border-border/40 bg-muted/25 px-2.5">
        <span className="min-w-0 truncate font-mono text-[10px] lowercase tracking-wide text-muted-foreground/75">
          {languageLabel}
        </span>
        <CopyButton
          className="ml-auto opacity-0 group-hover/code:opacity-100 focus-visible:opacity-100"
          label={`Copy ${languageLabel} code`}
          text={code}
        />
      </div>
      <div className="max-w-full overflow-x-auto">
        <HighlightedCode
          content={code}
          languageHint={language}
          loadingFallback="plain"
          relativePath=""
        />
      </div>
    </div>
  );
}
