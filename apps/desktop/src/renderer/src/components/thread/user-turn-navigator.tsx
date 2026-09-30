import { useEffect, useRef, type KeyboardEvent } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface UserTurnAnchor {
  id: string;
  label: string;
  active: boolean;
}

export interface UserTurnNavigatorProps {
  turns: UserTurnAnchor[];
  onSelect: (id: string) => void;
  className?: string;
}

function readableLabel(label: string): string {
  return (
    label
      .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim() || "Untitled message"
  );
}

export function UserTurnNavigator({
  turns,
  onSelect,
  className,
}: UserTurnNavigatorProps) {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const compact = turns.length > 18;
  const veryCompact = turns.length > 36;
  const activeIndex = turns.findIndex((turn) => turn.active);

  useEffect(() => {
    buttonRefs.current.length = turns.length;
  }, [turns.length]);

  useEffect(() => {
    const activeButton = buttonRefs.current[activeIndex];
    if (!activeButton || typeof activeButton.scrollIntoView !== "function") {
      return;
    }
    activeButton.scrollIntoView({ block: "nearest" });
  }, [activeIndex, turns.length]);

  if (turns.length === 0) return null;

  const moveFocus = (
    index: number,
    event: KeyboardEvent<HTMLButtonElement>,
  ) => {
    let nextIndex: number | undefined;

    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        nextIndex = Math.min(index + 1, turns.length - 1);
        break;
      case "ArrowUp":
      case "ArrowLeft":
        nextIndex = Math.max(index - 1, 0);
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = turns.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    buttonRefs.current[nextIndex]?.focus();
  };

  return (
    <nav
      aria-label="User message navigation"
      data-slot="user-turn-navigator"
      data-density={veryCompact ? "dense" : compact ? "compact" : "default"}
      className={cn(
        "w-8 rounded-full border border-border/55 bg-background/78 p-1 shadow-[0_8px_24px_rgba(0,0,0,0.055),inset_0_1px_0_rgba(255,255,255,0.45)] backdrop-blur-md dark:bg-background/72 dark:shadow-[0_8px_24px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.04)]",
        className,
      )}
    >
      <div className="relative">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-2 left-1/2 w-px -translate-x-1/2 bg-gradient-to-b from-transparent via-border/75 to-transparent"
        />

        <ol
          className={cn(
            "relative m-0 flex max-h-[min(52vh,23rem)] list-none flex-col items-center overflow-x-hidden overflow-y-auto p-0 overscroll-contain scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            compact ? "gap-0" : "gap-0.5",
          )}
        >
          {turns.map((turn, index) => {
            const label = readableLabel(turn.label);

            return (
              <li key={turn.id} className="relative z-10 flex shrink-0">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        ref={(node) => {
                          buttonRefs.current[index] = node;
                        }}
                        type="button"
                        aria-label={`Jump to message ${index + 1}: ${label}`}
                        aria-current={turn.active ? "location" : undefined}
                        onClick={() => onSelect(turn.id)}
                        onKeyDown={(event) => moveFocus(index, event)}
                        className={cn(
                          "group/anchor flex w-6 items-center justify-center rounded-full outline-none transition-colors duration-150 motion-reduce:transition-none",
                          veryCompact ? "h-3" : compact ? "h-4" : "h-5",
                          "hover:bg-muted/80 focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/45",
                        )}
                      />
                    }
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "block rounded-full border border-background shadow-[0_0_0_1px_var(--border)] transition-[width,height,background-color,box-shadow] duration-150 motion-reduce:transition-none",
                        turn.active
                          ? "h-1.5 w-4 bg-[var(--brand)] shadow-[0_0_0_2px_color-mix(in_oklch,var(--brand)_18%,transparent)]"
                          : "size-1.5 bg-muted-foreground/42 group-hover/anchor:bg-muted-foreground/70",
                      )}
                    />
                  </TooltipTrigger>
                  <TooltipContent
                    side="right"
                    sideOffset={7}
                    align="center"
                    className="max-w-64 px-2.5 py-1.5"
                  >
                    <span className="block truncate">
                      <span className="mr-1.5 text-background/60 tabular-nums">
                        {index + 1}
                      </span>
                      {label}
                    </span>
                  </TooltipContent>
                </Tooltip>
              </li>
            );
          })}
        </ol>
      </div>
    </nav>
  );
}
