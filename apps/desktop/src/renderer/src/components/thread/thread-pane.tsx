import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconArrowDown,
  IconFolder,
  IconSparkles,
  IconX,
} from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { hasRunningRun } from "@/state/agent-stream";
import type {
  ContextCommand,
  ImageAttachmentInput,
  PermissionMode,
  ProviderProfile,
  SavedImageAttachment,
  ThreadRecord,
  ThreadTimeline,
  UserMessagePart,
  UserTimelineItem,
  WorkspaceFileMatch,
} from "@shared/contracts";
import { AssistantTurn } from "./assistant-turn";
import { Composer } from "./composer";
import { FileReferenceChip } from "./file-reference-chip";
import { UserTurnNavigator } from "./user-turn-navigator";

const BOTTOM_PROXIMITY_PX = 48;
const EMPTY_TIMELINE_ITEMS: ThreadTimeline["items"] = [];

function userTurnLabel(item: UserTimelineItem): string {
  const content = item.parts?.length
    ? item.parts
        .map((part) =>
          part.type === "text" ? part.text : `@${part.relativePath}`,
        )
        .join("")
    : item.content;
  const readable = content
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!readable) return "Message with attachments";
  return readable.length > 88 ? `${readable.slice(0, 87)}…` : readable;
}

function smoothScrollBehavior(): ScrollBehavior {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

export function UserMessageContent({ item }: { item: UserTimelineItem }) {
  if (!item.parts?.length) {
    return <span className="whitespace-pre-wrap">{item.content}</span>;
  }
  return (
    <span className="whitespace-normal">
      {item.parts.map((part, index) =>
        part.type === "text" ? (
          <span key={`text:${index}`} className="whitespace-pre-wrap">
            {part.text}
          </span>
        ) : (
          <FileReferenceChip
            key={`file:${part.relativePath}:${index}`}
            name={part.name}
            relativePath={part.relativePath}
            className="mx-0.5 align-middle"
          />
        ),
      )}
    </span>
  );
}

export interface ThreadPaneProps {
  thread: ThreadRecord;
  timeline?: ThreadTimeline;
  loading: boolean;
  focused: boolean;
  split: boolean;
  providers: ProviderProfile[];
  permissionMode: PermissionMode;
  maxContextTokens: number;
  onFocus: () => void;
  onClose?: () => void;
  onSend: (
    prompt: string,
    displayPrompt?: string,
    imageAttachments?: SavedImageAttachment[],
    displayParts?: UserMessagePart[],
  ) => Promise<void>;
  onStop: () => Promise<void>;
  onSlashCommand: (command: ContextCommand) => Promise<void>;
  onProviderChange: (providerId: string) => Promise<void>;
  onPermissionModeChange: (mode: PermissionMode) => Promise<void>;
  onSearchWorkspaceFiles?: (
    threadId: string,
    query: string,
  ) => Promise<WorkspaceFileMatch[]>;
  onSaveImageAttachments?: (
    threadId: string,
    attachments: ImageAttachmentInput[],
  ) => Promise<SavedImageAttachment[]>;
  onDisclosureChange: (
    runId: string,
    disclosure: "expanded" | "collapsed",
  ) => void;
  onResolveApproval: (
    approvalId: string,
    decision: "allow-once" | "always-allow" | "deny",
  ) => Promise<void>;
  onOpenExternal: (url: string) => void;
  onChangeWorkspace?: () => void;
}

export function ThreadPane({
  thread,
  timeline,
  loading,
  focused,
  split,
  providers,
  permissionMode,
  maxContextTokens,
  onFocus,
  onClose,
  onSend,
  onStop,
  onSlashCommand,
  onProviderChange,
  onPermissionModeChange,
  onSearchWorkspaceFiles,
  onSaveImageAttachments,
  onDisclosureChange,
  onResolveApproval,
  onOpenExternal,
  onChangeWorkspace,
}: ThreadPaneProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const userTurnNodes = useRef(new Map<string, HTMLElement>());
  const followTail = useRef(true);
  const jumpingToBottom = useRef(false);
  const lastScrollTop = useRef(0);
  const scrollFrame = useRef<number | null>(null);
  const streamFrame = useRef<number | null>(null);
  const jumpUnlockTimer = useRef<number | null>(null);
  const previousLastUserId = useRef<string | undefined>(undefined);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [activeUserTurnId, setActiveUserTurnId] = useState<string>();
  const items = timeline?.items ?? EMPTY_TIMELINE_ITEMS;
  const running = hasRunningRun(timeline);
  const userTurns = useMemo(
    () =>
      items
        .filter((item): item is UserTimelineItem => item.type === "user")
        .map((item) => ({ id: item.id, label: userTurnLabel(item) })),
    [items],
  );
  const streamSignature = useMemo(
    () =>
      items
        .map((item) =>
          item.type === "assistant"
            ? `${item.id}:${item.steps.length}:${item.draftAnswer.length}:${item.finalAnswer.length}:${item.status}`
            : item.id,
        )
        .join("|"),
    [items],
  );

  const clearJumpUnlockTimer = useCallback(() => {
    if (jumpUnlockTimer.current === null) return;
    window.clearTimeout(jumpUnlockTimer.current);
    jumpUnlockTimer.current = null;
  }, []);

  const updateScrollState = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const distanceFromBottom = Math.max(
      0,
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
    );
    const nearBottom = distanceFromBottom <= BOTTOM_PROXIMITY_PX;
    const movingUp = scroller.scrollTop < lastScrollTop.current - 1;
    if (nearBottom) {
      followTail.current = true;
      jumpingToBottom.current = false;
      clearJumpUnlockTimer();
    } else if (movingUp) {
      followTail.current = false;
      jumpingToBottom.current = false;
      clearJumpUnlockTimer();
    }
    lastScrollTop.current = scroller.scrollTop;
    setShowJumpToBottom(!nearBottom && !jumpingToBottom.current);

    if (!userTurns.length) {
      setActiveUserTurnId(undefined);
      return;
    }
    const probe = scroller.scrollTop + scroller.clientHeight * 0.24;
    let nextActive = userTurns[0].id;
    for (const turn of userTurns) {
      const node = userTurnNodes.current.get(turn.id);
      if (!node || node.offsetTop > probe) break;
      nextActive = turn.id;
    }
    setActiveUserTurnId(nextActive);
  }, [clearJumpUnlockTimer, userTurns]);

  const scheduleScrollState = useCallback(() => {
    if (scrollFrame.current !== null) return;
    scrollFrame.current = window.requestAnimationFrame(() => {
      scrollFrame.current = null;
      updateScrollState();
    });
  }, [updateScrollState]);

  const handleScroll = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const distanceFromBottom = Math.max(
      0,
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
    );
    if (distanceFromBottom <= BOTTOM_PROXIMITY_PX) {
      followTail.current = true;
      jumpingToBottom.current = false;
      clearJumpUnlockTimer();
    } else if (scroller.scrollTop < lastScrollTop.current - 1) {
      followTail.current = false;
      jumpingToBottom.current = false;
      clearJumpUnlockTimer();
    }
    scheduleScrollState();
  }, [clearJumpUnlockTimer, scheduleScrollState]);

  const registerUserTurn = useCallback(
    (id: string, node: HTMLElement | null) => {
      if (node) userTurnNodes.current.set(id, node);
      else userTurnNodes.current.delete(id);
    },
    [],
  );

  const jumpToBottom = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    followTail.current = true;
    jumpingToBottom.current = true;
    clearJumpUnlockTimer();
    scroller.scrollTo({
      top: scroller.scrollHeight,
      behavior: smoothScrollBehavior(),
    });
    setShowJumpToBottom(false);
    jumpUnlockTimer.current = window.setTimeout(() => {
      jumpUnlockTimer.current = null;
      jumpingToBottom.current = false;
      updateScrollState();
    }, 1_200);
  }, [clearJumpUnlockTimer, updateScrollState]);

  const finishJumpToBottom = useCallback(() => {
    if (!jumpingToBottom.current) return;
    jumpingToBottom.current = false;
    clearJumpUnlockTimer();
    updateScrollState();
  }, [clearJumpUnlockTimer, updateScrollState]);

  const cancelJumpToBottom = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller || !jumpingToBottom.current) return;
    jumpingToBottom.current = false;
    followTail.current = false;
    clearJumpUnlockTimer();
    scroller.scrollTo({ top: scroller.scrollTop, behavior: "auto" });
    scheduleScrollState();
  }, [clearJumpUnlockTimer, scheduleScrollState]);

  const jumpToUserTurn = useCallback(
    (id: string) => {
      const scroller = scrollRef.current;
      const target = userTurnNodes.current.get(id);
      if (!scroller || !target) return;
      followTail.current = false;
      jumpingToBottom.current = false;
      clearJumpUnlockTimer();
      const scrollerTop = scroller.getBoundingClientRect().top;
      const targetTop = target.getBoundingClientRect().top;
      scroller.scrollTo({
        top: Math.max(0, scroller.scrollTop + targetTop - scrollerTop - 24),
        behavior: smoothScrollBehavior(),
      });
      setActiveUserTurnId(id);
      setShowJumpToBottom(true);
    },
    [clearJumpUnlockTimer],
  );

  useEffect(() => {
    followTail.current = true;
    jumpingToBottom.current = false;
    clearJumpUnlockTimer();
    lastScrollTop.current = 0;
    previousLastUserId.current = undefined;
    setShowJumpToBottom(false);
    setActiveUserTurnId(userTurns.at(-1)?.id);
    const frame = window.requestAnimationFrame(() => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: "auto" });
      lastScrollTop.current = scroller.scrollTop;
      updateScrollState();
    });
    return () => window.cancelAnimationFrame(frame);
    // Reset only when the pane starts showing a different task.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.id]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const lastUserId = userTurns.at(-1)?.id;
    if (
      lastUserId !== undefined &&
      previousLastUserId.current !== undefined &&
      lastUserId !== previousLastUserId.current
    ) {
      followTail.current = true;
      jumpingToBottom.current = false;
      clearJumpUnlockTimer();
    }
    previousLastUserId.current = lastUserId;
    if (streamFrame.current !== null) {
      window.cancelAnimationFrame(streamFrame.current);
    }
    streamFrame.current = window.requestAnimationFrame(() => {
      streamFrame.current = null;
      if (followTail.current) {
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: "auto" });
      }
      updateScrollState();
    });
    return () => {
      if (streamFrame.current !== null) {
        window.cancelAnimationFrame(streamFrame.current);
        streamFrame.current = null;
      }
    };
  }, [clearJumpUnlockTimer, streamSignature, updateScrollState, userTurns]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.addEventListener("scrollend", finishJumpToBottom);
    return () => scroller.removeEventListener("scrollend", finishJumpToBottom);
  }, [finishJumpToBottom]);

  useEffect(() => {
    const scroller = scrollRef.current;
    const content = scroller?.firstElementChild;
    if (!scroller || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followTail.current) {
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: "auto" });
      }
      scheduleScrollState();
    });
    observer.observe(scroller);
    observer.observe(content);
    return () => observer.disconnect();
  }, [loading, scheduleScrollState, thread.id]);

  useEffect(
    () => () => {
      if (scrollFrame.current !== null) {
        window.cancelAnimationFrame(scrollFrame.current);
      }
      if (streamFrame.current !== null) {
        window.cancelAnimationFrame(streamFrame.current);
      }
      clearJumpUnlockTimer();
    },
    [clearJumpUnlockTimer],
  );

  return (
    <section
      className={cn(
        "relative flex h-full min-w-0 flex-col bg-background",
        split && focused && "ring-1 ring-inset ring-[var(--brand)]/30",
      )}
      aria-label={`Conversation: ${thread.title}`}
      onPointerDown={onFocus}
    >
      {split && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 px-3">
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              thread.status === "running"
                ? "animate-pulse bg-[var(--brand)]"
                : "bg-muted-foreground/35",
            )}
          />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {thread.title}
          </span>
          <span className="hidden truncate text-[10px] text-muted-foreground xl:block">
            {thread.workspaceName}
          </span>
          {onClose && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Close split"
                    onClick={onClose}
                  />
                }
              >
                <IconX />
              </TooltipTrigger>
              <TooltipContent>Close split</TooltipContent>
            </Tooltip>
          )}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          className="h-full overflow-y-auto overscroll-contain"
          onScroll={handleScroll}
          onWheel={cancelJumpToBottom}
          onTouchStart={cancelJumpToBottom}
          onPointerDown={cancelJumpToBottom}
        >
          {loading ? (
            <div className="mx-auto max-w-[820px] space-y-6 px-6 py-12">
              <Skeleton className="ml-auto h-16 w-3/5 rounded-xl" />
              <div className="space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            </div>
          ) : items.length === 0 ? (
            <div className="flex min-h-full items-center justify-center px-6 pb-20">
              <div className="max-w-md -translate-y-7 text-center">
                <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-[14px] border border-border/70 bg-muted/25 text-muted-foreground shadow-sm">
                  <IconSparkles className="size-5 stroke-[1.4]" />
                </div>
                <h1 className="text-[24px] font-medium tracking-[-0.025em] text-foreground/88">
                  What should we build in {thread.workspaceName}?
                </h1>
                <p className="mx-auto mt-2 max-w-sm text-xs leading-5 text-muted-foreground">
                  Walle works locally with your files, tools, skills, memory,
                  and sandbox.
                </p>
                <div className="mt-5 inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/25 px-2.5 py-1 text-[10px] text-muted-foreground">
                  <IconFolder className="size-3" />
                  <span className="max-w-64 truncate">
                    {thread.workspaceRoot}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div className="mx-auto w-full max-w-[820px] space-y-8 px-6 py-8 max-[720px]:px-4">
              {items.map((item) =>
                item.type === "user" ? (
                  <article
                    key={item.id}
                    ref={(node) => registerUserTurn(item.id, node)}
                    className="flex justify-end pl-[12%]"
                    aria-label="Your message"
                  >
                    <div className="max-w-full rounded-[13px] bg-[var(--user-message)] px-3.5 py-2.5 text-[13px] leading-5 text-foreground shadow-[inset_0_0_0_1px_var(--user-message-border)]">
                      <UserMessageContent item={item} />
                    </div>
                  </article>
                ) : (
                  <AssistantTurn
                    key={item.id}
                    item={item}
                    onDisclosureChange={onDisclosureChange}
                    onResolveApproval={onResolveApproval}
                    onOpenExternal={onOpenExternal}
                  />
                ),
              )}
              <div aria-hidden className="h-3" />
            </div>
          )}
        </div>

        {userTurns.length > 1 && (
          <div className="absolute left-2 top-1/2 z-20 -translate-y-1/2 max-[560px]:hidden">
            <UserTurnNavigator
              turns={userTurns.map((turn) => ({
                ...turn,
                active: turn.id === activeUserTurnId,
              }))}
              onSelect={jumpToUserTurn}
            />
          </div>
        )}

        <div
          className={cn(
            "pointer-events-none absolute bottom-3 left-1/2 z-30 -translate-x-1/2 transition-[opacity,transform] duration-150 motion-reduce:transition-none",
            showJumpToBottom
              ? "translate-y-0 opacity-100"
              : "translate-y-1 opacity-0",
          )}
          aria-hidden={!showJumpToBottom}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className={cn(
                    "group/latest relative isolate flex size-9 items-center justify-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/45",
                    showJumpToBottom
                      ? "pointer-events-auto"
                      : "pointer-events-none",
                  )}
                  aria-label="Jump to latest message"
                  tabIndex={showJumpToBottom ? 0 : -1}
                  data-running={running || undefined}
                  onClick={(event) => {
                    event.currentTarget.blur();
                    jumpToBottom();
                  }}
                />
              }
            >
              {running && showJumpToBottom && (
                <span
                  aria-hidden="true"
                  className="absolute inset-0 -z-10 animate-spin rounded-full opacity-85 blur-[0.5px] [animation-duration:1.6s] motion-reduce:animate-none"
                  style={{
                    background:
                      "conic-gradient(from 0deg, transparent 0deg 205deg, color-mix(in oklch, var(--brand) 48%, transparent) 245deg, var(--brand) 292deg, transparent 350deg)",
                  }}
                />
              )}
              <span
                aria-hidden="true"
                className="absolute inset-[2px] -z-10 rounded-full border border-border/70 bg-background/94 shadow-[0_7px_22px_rgba(0,0,0,0.11),0_1px_2px_rgba(0,0,0,0.06)] backdrop-blur-md transition-colors group-hover/latest:bg-background"
              />
              <IconArrowDown className="relative size-4" />
            </TooltipTrigger>
            <TooltipContent>Jump to latest message</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <Composer
        thread={thread}
        providers={providers}
        permissionMode={permissionMode}
        contextWindow={timeline?.contextWindow}
        maxContextTokens={maxContextTokens}
        running={running}
        focused={focused}
        onSend={onSend}
        onStop={onStop}
        onSlashCommand={onSlashCommand}
        onProviderChange={onProviderChange}
        onPermissionModeChange={onPermissionModeChange}
        onSearchWorkspaceFiles={onSearchWorkspaceFiles}
        onSaveImageAttachments={onSaveImageAttachments}
        onChangeWorkspace={onChangeWorkspace}
      />
    </section>
  );
}
