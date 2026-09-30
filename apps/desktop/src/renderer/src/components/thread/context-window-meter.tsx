import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface ContextWindowMeterProps {
  usedTokens?: number;
  maxTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  source?: "provider" | "estimated-history";
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  })
    .format(Math.max(0, Math.round(value)))
    .toLowerCase();
}

export function ContextWindowMeter({
  usedTokens,
  maxTokens,
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
  source,
}: ContextWindowMeterProps) {
  const hasUsage = Number.isFinite(usedTokens) && usedTokens !== undefined;
  const safeMaximum = Math.max(1, maxTokens);
  const safeUsed = hasUsage ? Math.max(0, usedTokens) : 0;
  const rawPercent = (safeUsed / safeMaximum) * 100;
  const percent = Math.min(100, Math.max(0, rawPercent));
  const roundedPercent = Math.round(rawPercent);
  const remainingPercent = Math.max(0, 100 - roundedPercent);
  const hasCacheData =
    source === "provider" && Number.isFinite(cacheReadTokens);
  const cachedInputPercent =
    hasCacheData && inputTokens && inputTokens > 0
      ? Math.min(100, Math.round(((cacheReadTokens ?? 0) / inputTokens) * 100))
      : 0;
  const tone =
    rawPercent >= 90
      ? "text-destructive"
      : rawPercent >= 75
        ? "text-[var(--warning)]"
        : "text-[var(--brand)]";
  const accessibleLabel = hasUsage
    ? `Context window: ${roundedPercent}% used, ${formatTokens(safeUsed)} of ${formatTokens(safeMaximum)} tokens`
    : `Context window: no usage data yet, configured budget ${formatTokens(safeMaximum)} tokens`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={accessibleLabel}
            className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/45"
          />
        }
      >
        <svg
          viewBox="0 0 20 20"
          className="size-[17px] -rotate-90"
          aria-hidden="true"
        >
          <circle
            cx="10"
            cy="10"
            r="7.25"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            className="text-border"
          />
          {hasUsage && (
            <circle
              cx="10"
              cy="10"
              r="7.25"
              pathLength="100"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={`${percent} 100`}
              className={cn("transition-[stroke-dasharray]", tone)}
            />
          )}
        </svg>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={7}
        className="block min-w-52 px-3 py-2.5"
      >
        <div className="text-[11px] font-medium text-background">
          {source === "estimated-history"
            ? "Estimated conversation context"
            : "Last model call context"}
        </div>
        {hasUsage ? (
          <>
            <div className="mt-1 text-xs text-background">
              {roundedPercent}% used · {remainingPercent}% remaining
            </div>
            <div className="mt-0.5 text-[11px] text-background/72">
              {formatTokens(safeUsed)} of {formatTokens(safeMaximum)} tokens
            </div>
            {source === "provider" &&
              Number.isFinite(inputTokens) &&
              Number.isFinite(outputTokens) && (
                <div className="mt-1 text-[10px] text-background/55">
                  Input {formatTokens(inputTokens ?? 0)} · Output{" "}
                  {formatTokens(outputTokens ?? 0)}
                </div>
              )}
            {source === "provider" && (
              <div className="mt-1.5 border-t border-background/15 pt-1.5">
                {hasCacheData ? (
                  <>
                    <div className="text-[11px] text-background/90">
                      Cached input {cachedInputPercent}%
                    </div>
                    <div className="mt-0.5 text-[10px] text-background/60">
                      Read {formatTokens(cacheReadTokens ?? 0)}
                      {cacheWriteTokens !== undefined &&
                        ` · Written ${formatTokens(cacheWriteTokens)}`}
                    </div>
                  </>
                ) : (
                  <div className="text-[10px] text-background/55">
                    Cache data not reported by provider
                  </div>
                )}
              </div>
            )}
            <div className="mt-1.5 border-t border-background/15 pt-1.5 text-[9px] leading-3.5 text-background/52">
              {source === "estimated-history"
                ? "Estimated after compaction; system and tool context may vary."
                : "Latest call · cache share of input tokens · configured budget."}
            </div>
          </>
        ) : (
          <>
            <div className="mt-1 text-[11px] text-background/72">
              No usage data yet
            </div>
            <div className="mt-0.5 text-[10px] text-background/52">
              Configured budget: {formatTokens(safeMaximum)} tokens
            </div>
          </>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
