import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Electron permission state can reject the async API. The focused,
      // renderer-local fallback below still copies without exposing an IPC API.
    }
  }

  const activeElement = document.activeElement;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (activeElement instanceof HTMLElement)
    activeElement.focus({ preventScroll: true });
  if (!copied) throw new Error("Clipboard copy was rejected");
}

interface CopyButtonProps {
  className?: string;
  label: string;
  text: string;
}

export function CopyButton({ className, label, text }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  return (
    <button
      type="button"
      className={cn(
        "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-[color,background-color,opacity] duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        className,
      )}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      onClick={(event) => {
        event.stopPropagation();
        void writeClipboard(text)
          .then(() => {
            setCopied(true);
            if (resetTimer.current) clearTimeout(resetTimer.current);
            resetTimer.current = setTimeout(() => setCopied(false), 1_400);
          })
          .catch(() => setCopied(false));
      }}
    >
      {copied ? (
        <IconCheck className="size-3.5 text-[var(--success)]" />
      ) : (
        <IconCopy className="size-3.5" />
      )}
    </button>
  );
}
