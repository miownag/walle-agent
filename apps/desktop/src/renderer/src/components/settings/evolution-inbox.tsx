import { useMemo, useState } from "react";
import {
  IconArrowLeft,
  IconBolt,
  IconBrain,
  IconCheck,
  IconCircleCheck,
  IconCircleX,
  IconClock,
  IconInbox,
  IconLoader2,
  IconRefresh,
  IconShieldLock,
  IconWand,
  IconX,
} from "@tabler/icons-react";

import { Markdown } from "@/components/thread/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { EvolutionProposalSummary } from "@shared/contracts";

type ProposalFilter = "pending" | "approved" | "rejected" | "all";

interface EvolutionInboxProps {
  proposals: EvolutionProposalSummary[];
  loading: boolean;
  onBack: () => void;
  onRefresh: () => Promise<void>;
  onResolve: (
    proposal: EvolutionProposalSummary,
    decision: "approve" | "reject",
  ) => Promise<void>;
}

const FILTERS: Array<{
  id: ProposalFilter;
  label: string;
}> = [
  { id: "pending", label: "Pending" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Rejected" },
  { id: "all", label: "All" },
];

const REASON_LABELS: Record<EvolutionProposalSummary["reason"], string> = {
  explicit_remember: "Explicit memory request",
  periodic_review: "Periodic review",
  task_review: "Completed task review",
};

const EMPTY_COPY: Record<
  ProposalFilter,
  { title: string; description: string }
> = {
  pending: {
    title: "You’re caught up",
    description:
      "New memory and skill suggestions will wait here until you review them.",
  },
  approved: {
    title: "Nothing approved yet",
    description: "Proposals you approve and apply will be collected here.",
  },
  rejected: {
    title: "No rejected proposals",
    description: "Suggestions you decide not to keep will appear here.",
  },
  all: {
    title: "No evolution proposals yet",
    description:
      "After completed work, Walle can suggest durable memories and reusable skills.",
  },
};

function matchesFilter(
  proposal: EvolutionProposalSummary,
  filter: ProposalFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "approved") {
    return proposal.status === "approved" || proposal.status === "applied";
  }
  return proposal.status === filter;
}

function statusLabel(status: EvolutionProposalSummary["status"]): string {
  if (status === "applied") return "Applied";
  return status[0].toUpperCase() + status.slice(1);
}

function ProposalStatus({
  status,
}: {
  status: EvolutionProposalSummary["status"];
}) {
  const Icon =
    status === "pending"
      ? IconClock
      : status === "rejected"
        ? IconCircleX
        : IconCircleCheck;

  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 gap-1 border-border/70 px-2 text-[9px] font-medium",
        status === "pending" &&
          "border-amber-500/20 bg-amber-500/7 text-amber-700 dark:text-amber-300",
        status === "rejected" &&
          "border-destructive/15 bg-destructive/6 text-destructive",
        (status === "approved" || status === "applied") &&
          "border-emerald-500/20 bg-emerald-500/7 text-emerald-700 dark:text-emerald-300",
      )}
    >
      <Icon className="size-3" />
      {statusLabel(status)}
    </Badge>
  );
}

function ProposalCard({
  proposal,
  resolving,
  onResolve,
}: {
  proposal: EvolutionProposalSummary;
  resolving: {
    id: string;
    decision: "approve" | "reject";
  } | null;
  onResolve: (
    proposal: EvolutionProposalSummary,
    decision: "approve" | "reject",
  ) => Promise<void>;
}) {
  const TypeIcon = proposal.type === "skill" ? IconWand : IconBrain;
  const isResolving = resolving?.id === proposal.id;

  return (
    <article className="overflow-hidden rounded-2xl border border-border/70 bg-card/55 shadow-[0_1px_2px_0_rgb(0_0_0/0.025),0_10px_28px_-24px_rgb(0_0_0/0.28)]">
      <div className="px-5 py-4">
        <div className="flex items-start gap-3.5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/35 text-muted-foreground">
            <TypeIcon className="size-[17px]" stroke={1.75} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-start gap-x-2 gap-y-1.5">
              <h3 className="min-w-0 flex-1 text-[13px] font-semibold leading-5 tracking-[-0.01em]">
                {proposal.title}
              </h3>
              <ProposalStatus status={proposal.status} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
              <span className="capitalize">{proposal.type} suggestion</span>
              <span aria-hidden="true">·</span>
              <span>{REASON_LABELS[proposal.reason]}</span>
              {proposal.confidence !== undefined && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    {Math.round(proposal.confidence * 100)}% confidence
                  </span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <time dateTime={proposal.createdAt}>
                {formatRelativeTime(proposal.createdAt)}
              </time>
            </div>
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-border/55 bg-muted/20 px-4 py-3">
          <Markdown
            className="text-xs leading-5 text-foreground/88 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0"
            onOpenExternal={() => undefined}
          >
            {proposal.content}
          </Markdown>
        </div>
      </div>

      {proposal.status === "pending" && (
        <footer className="flex items-center justify-between gap-3 border-t border-border/55 bg-muted/12 px-5 py-3">
          <p className="text-[10px] text-muted-foreground">
            Nothing changes until you approve this proposal.
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground hover:text-destructive"
              disabled={resolving !== null}
              onClick={() => void onResolve(proposal, "reject")}
            >
              {isResolving && resolving.decision === "reject" ? (
                <IconLoader2 className="animate-spin" />
              ) : (
                <IconX />
              )}
              Reject
            </Button>
            <Button
              size="sm"
              disabled={resolving !== null}
              onClick={() => void onResolve(proposal, "approve")}
            >
              {isResolving && resolving.decision === "approve" ? (
                <IconLoader2 className="animate-spin" />
              ) : (
                <IconCheck />
              )}
              Approve & apply
            </Button>
          </div>
        </footer>
      )}
    </article>
  );
}

function LoadingCards() {
  return (
    <div className="space-y-3" aria-label="Loading evolution proposals">
      {[0, 1, 2].map((item) => (
        <div
          key={item}
          className="rounded-2xl border border-border/60 bg-card/45 px-5 py-4"
        >
          <div className="flex gap-3.5">
            <Skeleton className="size-9 rounded-xl" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-2/5" />
              <Skeleton className="h-2.5 w-3/5" />
            </div>
          </div>
          <Skeleton className="mt-4 h-16 w-full rounded-xl" />
        </div>
      ))}
    </div>
  );
}

export function EvolutionInbox({
  proposals,
  loading,
  onBack,
  onRefresh,
  onResolve,
}: EvolutionInboxProps) {
  const [filter, setFilter] = useState<ProposalFilter>("pending");
  const [resolving, setResolving] = useState<{
    id: string;
    decision: "approve" | "reject";
  } | null>(null);
  const counts = useMemo(
    () => ({
      pending: proposals.filter((item) => item.status === "pending").length,
      approved: proposals.filter(
        (item) => item.status === "approved" || item.status === "applied",
      ).length,
      rejected: proposals.filter((item) => item.status === "rejected").length,
      all: proposals.length,
    }),
    [proposals],
  );
  const filtered = useMemo(
    () => proposals.filter((proposal) => matchesFilter(proposal, filter)),
    [filter, proposals],
  );

  const resolve = async (
    proposal: EvolutionProposalSummary,
    decision: "approve" | "reject",
  ) => {
    setResolving({ id: proposal.id, decision });
    try {
      await onResolve(proposal, decision);
    } finally {
      setResolving(null);
    }
  };

  return (
    <section
      className="h-full min-h-0 min-w-0 overflow-y-auto overflow-x-hidden bg-background"
      aria-label="Evolution inbox"
    >
      <div className="mx-auto w-full max-w-[940px] px-8 py-7 max-[680px]:px-4">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 mb-5 text-muted-foreground"
          onClick={onBack}
        >
          <IconArrowLeft />
          Back to conversations
        </Button>

        <header className="flex items-start gap-4">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl border border-[var(--brand)]/15 bg-[var(--brand-soft)] text-[var(--brand)]">
            <IconBolt className="size-[19px]" stroke={1.8} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold tracking-[-0.015em]">
              Evolution inbox
            </h1>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
              Review memories and reusable skills Walle suggests after completed
              work. Reviews send recent conversation and tool context to your
              configured AI provider; you decide what becomes active.
            </p>
          </div>
          <div className="hidden items-center gap-1.5 rounded-full border border-border/60 bg-muted/25 px-2.5 py-1.5 text-[9px] text-muted-foreground sm:flex">
            <IconShieldLock className="size-3" />
            Proposals stored locally
          </div>
        </header>

        <div className="mt-7 flex flex-wrap items-center gap-2 border-b border-border/60 pb-3">
          <div
            className="flex flex-wrap items-center gap-1"
            aria-label="Proposal status"
          >
            {FILTERS.map((item) => (
              <Button
                key={item.id}
                type="button"
                size="sm"
                variant="ghost"
                aria-pressed={filter === item.id}
                className={cn(
                  "h-7 gap-1.5 px-2.5 text-[11px] text-muted-foreground",
                  filter === item.id && "bg-muted text-foreground",
                )}
                onClick={() => setFilter(item.id)}
              >
                {item.label}
                <span
                  className={cn(
                    "min-w-4 rounded-full bg-muted px-1 text-center text-[9px] tabular-nums",
                    filter === item.id && "bg-background/70",
                  )}
                >
                  {counts[item.id]}
                </span>
              </Button>
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto text-muted-foreground"
            aria-label="Refresh proposals"
            disabled={loading}
            onClick={() => void onRefresh()}
          >
            <IconRefresh className={loading ? "animate-spin" : ""} />
            Refresh
          </Button>
        </div>

        <div className="pt-4">
          {loading && filtered.length === 0 ? (
            <LoadingCards />
          ) : filtered.length === 0 ? (
            <div className="flex min-h-[360px] flex-col items-center justify-center px-6 text-center">
              <div className="flex size-11 items-center justify-center rounded-2xl border border-border/65 bg-muted/25 text-muted-foreground">
                {filter === "pending" ? (
                  <IconCheck className="size-5" />
                ) : (
                  <IconInbox className="size-5" />
                )}
              </div>
              <h2 className="mt-4 text-sm font-medium">
                {EMPTY_COPY[filter].title}
              </h2>
              <p className="mt-1.5 max-w-sm text-xs leading-5 text-muted-foreground">
                {EMPTY_COPY[filter].description}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {filtered.map((proposal) => (
                <ProposalCard
                  key={proposal.id}
                  proposal={proposal}
                  resolving={resolving}
                  onResolve={resolve}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
