import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useTheme } from "next-themes";
import { IconFolderPlus, IconLoader2, IconSparkles } from "@tabler/icons-react";
import { toast } from "sonner";

import { DeveloperDock } from "@/components/dock/developer-dock";
import { ThreadSplitLayout } from "@/components/layout/thread-split-layout";
import { EvolutionInbox } from "@/components/settings/evolution-inbox";
import { SettingsPage } from "@/components/settings/settings-page";
import { Sidebar } from "@/components/shell/sidebar";
import { Titlebar } from "@/components/shell/titlebar";
import { ThreadPane } from "@/components/thread/thread-pane";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { agentStreamReducer, initialStreamState } from "@/state/agent-stream";
import type {
  AgentEventEnvelope,
  AppSettings,
  BootstrapPayload,
  ContextCommand,
  DeepPartial,
  DesktopApi,
  EvolutionProposalSummary,
  ProviderProfileInput,
  SavedImageAttachment,
  ThreadAttentionEvent,
  ThreadNavigationRequest,
  ThreadRecord,
  ThreadStateEvent,
  UserMessagePart,
} from "@shared/contracts";

function replaceThread(
  threads: ThreadRecord[],
  updated: ThreadRecord,
): ThreadRecord[] {
  return threads
    .map((thread) => (thread.id === updated.id ? updated : thread))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Something went wrong.";
}

function compareNavigationTime(
  left: ThreadNavigationRequest,
  right: ThreadNavigationRequest,
): number {
  const leftTime = Date.parse(left.requestedAt);
  const rightTime = Date.parse(right.requestedAt);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
    return leftTime - rightTime;
  }
  return left.requestedAt.localeCompare(right.requestedAt);
}

function applyAppearance(
  settings: AppSettings,
  setTheme: (theme: string) => void,
) {
  setTheme(settings.appearance.theme);
  const root = document.documentElement;
  root.dataset.density = settings.appearance.density;
  root.classList.toggle("reduce-motion", settings.appearance.reduceMotion);
  root.style.setProperty("--ui-font-size", `${settings.appearance.fontSize}px`);
  root.style.setProperty(
    "--code-font-size",
    `${settings.appearance.codeFontSize}px`,
  );
}

function LoadingShell() {
  return (
    <div className="flex h-screen flex-col bg-background">
      <div className="h-12 shrink-0 border-b bg-muted/15" />
      <div className="flex min-h-0 flex-1">
        <div className="hidden w-[276px] shrink-0 border-r bg-sidebar min-[861px]:block" />
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          <IconLoader2 className="mr-2 size-4 animate-spin" /> Starting Walle
          locally…
        </div>
      </div>
    </div>
  );
}

function BootstrapError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-screen items-center justify-center bg-background px-6 text-center">
      <div className="max-w-sm">
        <div className="mx-auto mb-4 flex size-10 items-center justify-center rounded-xl border bg-muted text-muted-foreground">
          <IconSparkles className="size-5" />
        </div>
        <h1 className="text-base font-semibold">Walle couldn’t start</h1>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          {message}
        </p>
        <Button className="mt-4" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </div>
  );
}

export function App() {
  const api = window.walle as DesktopApi | undefined;
  const { setTheme } = useTheme();
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [bootstrapError, setBootstrapError] = useState("");
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [threads, setThreads] = useState<ThreadRecord[]>([]);
  const [draft, setDraft] = useState<{
    key: string;
    workspaceRoot: string;
    providerProfileId: string;
  } | null>(null);
  const draftThreadPromise = useRef<Promise<ThreadRecord> | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [stream, dispatchStream] = useReducer(
    agentStreamReducer,
    initialStreamState,
  );
  const [paneIds, setPaneIds] = useState<string[]>([]);
  const [focusedPane, setFocusedPane] = useState(0);
  const [loadedTimelines, setLoadedTimelines] = useState<Set<string>>(
    new Set(),
  );
  const [loadingTimelines, setLoadingTimelines] = useState<Set<string>>(
    new Set(),
  );
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [evolutionOpen, setEvolutionOpen] = useState(false);
  const [evolutionProposals, setEvolutionProposals] = useState<
    EvolutionProposalSummary[]
  >([]);
  const [evolutionLoading, setEvolutionLoading] = useState(false);
  const [dockOpen, setDockOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 860);
  const settingsSequence = useRef(0);
  const bootstrapStarted = useRef(-1);
  const timelineHydrationGeneration = useRef(new Map<string, number>());
  const focusedPaneRef = useRef(focusedPane);
  const handledAttentionKeys = useRef(new Set<string>());
  const latestNavigation = useRef<ThreadNavigationRequest | null>(null);
  const visibilitySyncSequence = useRef(0);
  const evolutionLoadGeneration = useRef(0);
  focusedPaneRef.current = focusedPane;

  const knownThreadIdSignature = JSON.stringify(
    threads.map((thread) => thread.id).sort(),
  );
  const utilityPageOpen = settingsOpen || evolutionOpen;
  const visibleThreadIds = useMemo(() => {
    if (utilityPageOpen || draft) return [];
    const knownThreadIds = new Set<string>(
      JSON.parse(knownThreadIdSignature) as string[],
    );
    return [
      ...new Set(paneIds.filter((threadId) => knownThreadIds.has(threadId))),
    ];
  }, [draft, knownThreadIdSignature, paneIds, utilityPageOpen]);

  useEffect(() => {
    if (!api) {
      setBootstrapError(
        "The secure desktop bridge is unavailable. Restart the Walle desktop application.",
      );
      return;
    }
    if (bootstrapStarted.current === bootstrapAttempt) return;
    bootstrapStarted.current = bootstrapAttempt;
    setBootstrapError("");
    void api
      .bootstrap()
      .then((payload) => {
        setBootstrap(payload);
        setSettings(payload.settings);
        setThreads(payload.threads);
        const first = payload.threads
          .filter((thread) => !thread.archived)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        setPaneIds((current) =>
          current.length ? current : first ? [first.id] : [],
        );
      })
      .catch((cause: unknown) => setBootstrapError(errorMessage(cause)));
  }, [api, bootstrapAttempt]);

  useEffect(() => {
    if (settings) applyAppearance(settings, setTheme);
  }, [settings, setTheme]);

  useEffect(() => {
    if (utilityPageOpen && api) void api.hideBrowser();
  }, [api, utilityPageOpen]);

  const loadEvolution = async () => {
    if (!api) return;
    const generation = evolutionLoadGeneration.current + 1;
    evolutionLoadGeneration.current = generation;
    setEvolutionLoading(true);
    try {
      const proposals = await api.listEvolutionProposals();
      if (evolutionLoadGeneration.current !== generation) return;
      setEvolutionProposals(proposals);
    } catch (cause) {
      if (evolutionLoadGeneration.current !== generation) return;
      toast.error("Could not load evolution proposals", {
        description: errorMessage(cause),
      });
    } finally {
      if (evolutionLoadGeneration.current === generation) {
        setEvolutionLoading(false);
      }
    }
  };

  useEffect(() => {
    if (!bootstrap || !api) return;
    void loadEvolution();
    // Loaded once after bootstrap; proposal events refresh it thereafter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootstrap, api]);

  useEffect(() => {
    if (!api || !bootstrap) return;
    return api.onAgentEvent((event: AgentEventEnvelope) => {
      dispatchStream({ type: "event.received", event });
      setThreads((current) =>
        current.map((thread) => {
          if (thread.id !== event.threadId) return thread;
          let status = thread.status;
          if (event.type === "run.started") status = "running";
          if (event.type === "approval.requested") status = "approval";
          if (event.type === "run.completed" || event.type === "run.cancelled")
            status = "idle";
          if (event.type === "run.failed") status = "error";
          return { ...thread, status, updatedAt: event.timestamp };
        }),
      );
      if (event.type === "evolution.proposal") void loadEvolution();
    });
    // loadEvolution uses the same stable desktop API.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, bootstrap]);

  useEffect(() => {
    if (!api) return;
    for (const threadId of paneIds) {
      if (loadedTimelines.has(threadId) || loadingTimelines.has(threadId))
        continue;
      const generation =
        (timelineHydrationGeneration.current.get(threadId) ?? 0) + 1;
      timelineHydrationGeneration.current.set(threadId, generation);
      setLoadingTimelines((current) => new Set(current).add(threadId));
      void api
        .getTimeline(threadId)
        .then((timeline) => {
          if (
            timelineHydrationGeneration.current.get(threadId) !== generation
          ) {
            return;
          }
          dispatchStream({ type: "timeline.loaded", timeline });
          setLoadedTimelines((current) => new Set(current).add(threadId));
        })
        .catch((cause: unknown) => {
          if (
            timelineHydrationGeneration.current.get(threadId) !== generation
          ) {
            return;
          }
          toast.error("Could not load conversation", {
            description: errorMessage(cause),
          });
        })
        .finally(() => {
          if (
            timelineHydrationGeneration.current.get(threadId) !== generation
          ) {
            return;
          }
          setLoadingTimelines((current) => {
            const next = new Set(current);
            next.delete(threadId);
            return next;
          });
        });
    }
  }, [api, loadedTimelines, loadingTimelines, paneIds]);

  const activeThreadId = paneIds[focusedPane] ?? paneIds[0];
  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  const draftThread = useMemo<ThreadRecord | null>(() => {
    if (!draft) return null;
    const provider = settings?.providers.find(
      (item) => item.id === draft.providerProfileId,
    );
    const now = new Date().toISOString();
    return {
      id: draft.key,
      sessionId: draft.key,
      title: "New thread",
      workspaceRoot: draft.workspaceRoot,
      workspaceName:
        draft.workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1) ??
        draft.workspaceRoot,
      providerProfileId: draft.providerProfileId,
      model: provider?.model ?? "",
      pinned: false,
      archived: false,
      unread: false,
      status: "idle",
      createdAt: now,
      updatedAt: now,
    };
  }, [draft, settings?.providers]);

  const createThread = async (
    forcePickWorkspace = false,
    workspaceRootOverride?: string,
  ) => {
    if (!api || creating) return;
    setCreating(true);
    try {
      let workspaceRoot =
        workspaceRootOverride ??
        (!forcePickWorkspace
          ? draft?.workspaceRoot ?? activeThread?.workspaceRoot
          : undefined);
      if (!workspaceRoot)
        workspaceRoot = (await api.pickWorkspace()) ?? undefined;
      if (!workspaceRoot) return;
      const workspaceThread = threads.find(
        (thread) => thread.workspaceRoot === workspaceRoot,
      );
      draftThreadPromise.current = null;
      setDraft({
        key: `draft:${crypto.randomUUID()}`,
        workspaceRoot,
        providerProfileId:
          workspaceThread?.providerProfileId ??
          draft?.providerProfileId ??
          activeThread?.providerProfileId ??
          settings?.providers.find((item) => item.isDefault)?.id ??
          "",
      });
      setSettingsOpen(false);
      setEvolutionOpen(false);
    } catch (cause) {
      toast.error("Could not create a thread", {
        description: errorMessage(cause),
      });
    } finally {
      setCreating(false);
    }
  };

  const changeDraftWorkspace = async () => {
    if (!api || !draft) return;
    try {
      const workspaceRoot = await api.pickWorkspace();
      if (!workspaceRoot || workspaceRoot === draft.workspaceRoot) return;
      const existing = threads.find(
        (thread) => thread.workspaceRoot === workspaceRoot,
      );
      setDraft(
        (current) =>
          current && {
            ...current,
            workspaceRoot,
            providerProfileId:
              existing?.providerProfileId ?? current.providerProfileId,
          },
      );
    } catch (cause) {
      toast.error("Could not choose a workspace", {
        description: errorMessage(cause),
      });
    }
  };

  const ensureDraftThread = () => {
    if (!api || !draft)
      return Promise.reject(new Error("No draft workspace selected"));
    if (!draftThreadPromise.current) {
      draftThreadPromise.current = api
        .createThread({
          workspaceRoot: draft.workspaceRoot,
          providerProfileId: draft.providerProfileId || undefined,
        })
        .then((thread) => {
          if (!thread) throw new Error("Could not create the thread");
          return thread;
        })
        .catch((cause: unknown) => {
          draftThreadPromise.current = null;
          throw cause;
        });
    }
    return draftThreadPromise.current;
  };

  const sendDraftPrompt = async (
    prompt: string,
    displayPrompt?: string,
    imageAttachments?: SavedImageAttachment[],
    displayParts?: UserMessagePart[],
  ) => {
    const thread = await ensureDraftThread();
    setThreads((current) => [
      thread,
      ...current.filter((item) => item.id !== thread.id),
    ]);
    setPaneIds((current) =>
      current.length
        ? current.map((id, index) => (index === focusedPane ? thread.id : id))
        : [thread.id],
    );
    setDraft(null);
    await sendPrompt(
      thread.id,
      prompt,
      displayPrompt,
      imageAttachments,
      displayParts,
    );
  };

  const markThreadRead = useCallback(
    async (threadId: string) => {
      if (!api) return;
      try {
        const updated = await api.markThreadRead(threadId);
        setThreads((current) => replaceThread(current, updated));
      } catch (cause) {
        toast.error("Could not mark the task as read", {
          description: errorMessage(cause),
        });
      }
    },
    [api],
  );

  const selectThread = useCallback(
    (threadId: string) => {
      setDraft(null);
      draftThreadPromise.current = null;
      setSettingsOpen(false);
      setEvolutionOpen(false);
      setPaneIds((current) => {
        const existingPane = current.indexOf(threadId);
        if (existingPane >= 0) {
          focusedPaneRef.current = existingPane;
          setFocusedPane(existingPane);
          return current;
        }
        if (!current.length) {
          focusedPaneRef.current = 0;
          setFocusedPane(0);
          return [threadId];
        }
        const targetPane = Math.min(focusedPaneRef.current, current.length - 1);
        return current.map((id, index) =>
          index === targetPane ? threadId : id,
        );
      });
      void markThreadRead(threadId);
    },
    [markThreadRead],
  );

  const handleThreadAttention = useCallback(
    (event: ThreadAttentionEvent) => {
      if (!api) return;
      const attentionKey = JSON.stringify([event.threadId, event.runId]);
      if (handledAttentionKeys.current.has(attentionKey)) {
        void api
          .acknowledgeThreadAttention(event.threadId, event.runId)
          .catch(() => undefined);
        return;
      }
      handledAttentionKeys.current.add(attentionKey);
      if (handledAttentionKeys.current.size > 256) {
        const oldest = handledAttentionKeys.current.values().next().value;
        if (oldest) handledAttentionKeys.current.delete(oldest);
      }
      setThreads((current) =>
        current.map((thread) =>
          thread.id === event.threadId
            ? {
                ...thread,
                unread: true,
                unreadAt: event.completedAt,
              }
            : thread,
        ),
      );
      toast.success("Task completed", {
        description: `${event.threadTitle} · ${event.workspaceName}`,
        action: {
          label: "Open",
          onClick: () => selectThread(event.threadId),
        },
      });
      void api
        .acknowledgeThreadAttention(event.threadId, event.runId)
        .catch(() => undefined);
    },
    [api, selectThread],
  );

  const handleThreadNavigation = useCallback(
    (request: ThreadNavigationRequest, source: "live" | "pending" = "live") => {
      const current = latestNavigation.current;
      if (current?.requestId === request.requestId) return;
      if (current) {
        const comparison = compareNavigationTime(request, current);
        if (comparison < 0 || (comparison === 0 && source === "pending")) {
          return;
        }
      }
      latestNavigation.current = request;
      selectThread(request.threadId);
    },
    [selectThread],
  );

  useEffect(() => {
    if (!api || !bootstrap) return;
    const sequence = ++visibilitySyncSequence.current;
    let cancelled = false;
    let retryTimer: number | undefined;

    const syncVisibility = (retry: boolean) => {
      void api.setActiveThreadIds(visibleThreadIds).catch((cause: unknown) => {
        if (cancelled || sequence !== visibilitySyncSequence.current) return;
        if (!retry) {
          retryTimer = window.setTimeout(() => syncVisibility(true), 100);
          return;
        }
        // Visibility is a best-effort notification hint. A transient failure
        // must not interrupt switching between otherwise healthy tasks.
        console.warn("Could not update task visibility:", errorMessage(cause));
      });
    };

    syncVisibility(false);
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [api, bootstrap, visibleThreadIds]);

  useEffect(() => {
    if (!api || !bootstrap) return;
    let cancelled = false;

    const unsubscribeAttention = api.onThreadAttention(handleThreadAttention);
    const unsubscribeNavigation = api.onThreadNavigation(
      (request: ThreadNavigationRequest) =>
        handleThreadNavigation(request, "live"),
    );
    const unsubscribeState = api.onThreadState((event: ThreadStateEvent) => {
      setThreads((current) => replaceThread(current, event.thread));
    });
    void api
      .getPendingThreadAttentions()
      .then((events) => {
        if (cancelled) return;
        for (const event of events) handleThreadAttention(event);
      })
      .catch(() => undefined);
    void api
      .getPendingThreadNavigation()
      .then((request) => {
        if (!cancelled && request) handleThreadNavigation(request, "pending");
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unsubscribeAttention();
      unsubscribeNavigation();
      unsubscribeState();
    };
  }, [api, bootstrap, handleThreadAttention, handleThreadNavigation]);

  useEffect(() => {
    if (!api || !bootstrap) return;
    const markVisibleThreadsRead = () => {
      if (utilityPageOpen || !document.hasFocus()) return;
      for (const threadId of paneIds) {
        if (threads.some((thread) => thread.id === threadId && thread.unread)) {
          void markThreadRead(threadId);
        }
      }
    };
    markVisibleThreadsRead();
    window.addEventListener("focus", markVisibleThreadsRead);
    return () => window.removeEventListener("focus", markVisibleThreadsRead);
  }, [api, bootstrap, markThreadRead, paneIds, threads, utilityPageOpen]);

  const updateThread = async (
    threadId: string,
    patch: {
      title?: string;
      pinned?: boolean;
      archived?: boolean;
      providerProfileId?: string;
    },
  ) => {
    if (!api) return false;
    try {
      const updated = await api.updateThread(threadId, patch);
      setThreads((current) => replaceThread(current, updated));
      if (updated.archived) {
        setPaneIds((current) => {
          const next = current.filter((id) => id !== threadId);
          if (next.length) return next;
          const fallback = threads.find(
            (thread) => !thread.archived && thread.id !== threadId,
          );
          return fallback ? [fallback.id] : [];
        });
        setFocusedPane(0);
      }
      return true;
    } catch (cause) {
      toast.error("Could not update the thread", {
        description: errorMessage(cause),
      });
      return false;
    }
  };

  const deleteThread = async (threadId: string) => {
    if (!api) return;
    try {
      await api.deleteThread(threadId);
      const remaining = threads.filter((thread) => thread.id !== threadId);
      setThreads(remaining);
      setPaneIds((current) => {
        const next = current.filter((id) => id !== threadId);
        if (next.length) return next;
        const fallback = remaining.find((thread) => !thread.archived);
        return fallback ? [fallback.id] : [];
      });
      setFocusedPane(0);
    } catch (cause) {
      toast.error("Could not delete the thread", {
        description: errorMessage(cause),
      });
    }
  };

  const sendPrompt = async (
    threadId: string,
    prompt: string,
    displayPrompt = prompt,
    imageAttachments: SavedImageAttachment[] = [],
    displayParts?: UserMessagePart[],
  ) => {
    if (!api) return;
    const timestamp = new Date().toISOString();
    const pendingRunId = `pending:${crypto.randomUUID()}`;
    dispatchStream({
      type: "user.optimistic",
      threadId,
      id: `user:${crypto.randomUUID()}`,
      content: displayPrompt,
      parts: displayParts,
      createdAt: timestamp,
    });
    setThreads((current) =>
      current.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              status: "running",
              lastMessage: displayPrompt,
              updatedAt: timestamp,
            }
          : thread,
      ),
    );
    try {
      const { runId } = await api.startRun(
        threadId,
        prompt,
        imageAttachments,
        displayPrompt,
        displayParts,
      );
      dispatchStream({
        type: "run.ensure",
        threadId,
        runId,
        createdAt: timestamp,
      });
    } catch (cause) {
      const message = errorMessage(cause);
      dispatchStream({
        type: "run.start-failed",
        threadId,
        runId: pendingRunId,
        message,
        createdAt: new Date().toISOString(),
      });
      setThreads((current) =>
        current.map((thread) =>
          thread.id === threadId ? { ...thread, status: "error" } : thread,
        ),
      );
      toast.error("Could not start the run", { description: message });
      throw cause instanceof Error ? cause : new Error(message);
    }
  };

  const stopRun = async (threadId: string) => {
    if (!api) return;
    try {
      await api.cancelRun(threadId);
    } catch (cause) {
      toast.error("Could not stop the run", {
        description: errorMessage(cause),
      });
    }
  };

  const runContextCommand = async (
    threadId: string,
    command: ContextCommand,
  ) => {
    if (!api) return;
    if (command === "clear") {
      const reset = await api.clearContext(threadId);
      timelineHydrationGeneration.current.set(
        threadId,
        (timelineHydrationGeneration.current.get(threadId) ?? 0) + 1,
      );
      dispatchStream({ type: "timeline.cleared", timeline: reset.timeline });
      setThreads((current) => replaceThread(current, reset.thread));
      setLoadedTimelines((current) => new Set(current).add(threadId));
      setLoadingTimelines((current) => {
        const next = new Set(current);
        next.delete(threadId);
        return next;
      });
      toast.success("Context cleared", {
        description: "This task is ready with a fresh conversation context.",
      });
      return;
    }

    const result = await api.compactContext(threadId);
    dispatchStream({
      type: "context.compacted",
      threadId,
      afterTokens: result.afterTokens,
      updatedAt: new Date().toISOString(),
    });
    if (result.droppedMessages === 0) {
      toast.info("Context is already compact", {
        description: `${result.afterMessages} messages remain.`,
      });
      return;
    }
    toast.success("Context compacted", {
      description: `${result.beforeMessages} → ${result.afterMessages} messages · ${result.beforeTokens} → ${result.afterTokens} estimated tokens`,
    });
  };

  const changeDisclosure = (
    threadId: string,
    runId: string,
    disclosure: "expanded" | "collapsed",
  ) => {
    if (!api) return;
    dispatchStream({ type: "disclosure.changed", threadId, runId, disclosure });
    void api
      .setProcessDisclosure(threadId, runId, disclosure)
      .catch((cause: unknown) => {
        toast.error("Could not save disclosure preference", {
          description: errorMessage(cause),
        });
      });
  };

  const resolveApproval = async (
    approvalId: string,
    decision: "allow-once" | "always-allow" | "deny",
  ) => {
    if (!api) return;
    try {
      await api.resolveApproval(approvalId, decision);
    } catch (cause) {
      toast.error("Could not resolve approval", {
        description: errorMessage(cause),
      });
    }
  };

  const patchSettings = async (patch: DeepPartial<AppSettings>) => {
    if (!api) return;
    const sequence = ++settingsSequence.current;
    setSettingsSaving(true);
    try {
      const updated = await api.updateSettings(patch);
      if (sequence === settingsSequence.current) {
        setSettings(updated);
        void api
          .bootstrap()
          .then((snapshot) => {
            if (sequence !== settingsSequence.current) return;
            setBootstrap((current) =>
              current
                ? { ...current, capabilities: snapshot.capabilities }
                : current,
            );
          })
          .catch(() => undefined);
      }
    } catch (cause) {
      toast.error("Could not save settings", {
        description: errorMessage(cause),
      });
    } finally {
      if (sequence === settingsSequence.current) setSettingsSaving(false);
    }
  };

  const upsertProvider = async (input: ProviderProfileInput) => {
    if (!api) return false;
    setSettingsSaving(true);
    try {
      setSettings(await api.upsertProvider(input));
      const [threadResult, snapshotResult] = await Promise.allSettled([
        api.listThreads(),
        api.bootstrap(),
      ]);
      if (threadResult.status === "fulfilled") setThreads(threadResult.value);
      if (snapshotResult.status === "fulfilled") {
        setBootstrap((current) =>
          current
            ? { ...current, capabilities: snapshotResult.value.capabilities }
            : current,
        );
      }
      return true;
    } catch (cause) {
      toast.error("Could not save provider", {
        description: errorMessage(cause),
      });
      return false;
    } finally {
      setSettingsSaving(false);
    }
  };

  const removeProvider = async (providerId: string) => {
    if (!api) return false;
    setSettingsSaving(true);
    try {
      setSettings(await api.deleteProvider(providerId));
      const [threadResult, snapshotResult] = await Promise.allSettled([
        api.listThreads(),
        api.bootstrap(),
      ]);
      if (threadResult.status === "fulfilled") setThreads(threadResult.value);
      if (snapshotResult.status === "fulfilled") {
        setBootstrap((current) =>
          current
            ? { ...current, capabilities: snapshotResult.value.capabilities }
            : current,
        );
      }
      return true;
    } catch (cause) {
      toast.error("Could not delete provider", {
        description: errorMessage(cause),
      });
      return false;
    } finally {
      setSettingsSaving(false);
    }
  };

  const resolveEvolution = async (
    proposal: EvolutionProposalSummary,
    decision: "approve" | "reject",
  ) => {
    if (!api) return;
    if (!proposal.threadId) {
      toast.error(
        "Refresh Evolution to identify the task that owns this proposal.",
      );
      return;
    }
    try {
      await api.resolveEvolutionProposal(
        proposal.threadId,
        proposal.id,
        decision,
      );
      await loadEvolution();
      toast.success(
        decision === "approve" ? "Proposal applied" : "Proposal rejected",
      );
    } catch (cause) {
      toast.error("Could not resolve proposal", {
        description: errorMessage(cause),
      });
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey) return;
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        void createThread();
      }
      if (event.key === ",") {
        event.preventDefault();
        setEvolutionOpen(false);
        setSettingsOpen(true);
      }
      if (event.key.toLowerCase() === "b" && !event.shiftKey) {
        event.preventDefault();
        setSidebarOpen((open) => !open);
      }
      if (event.key.toLowerCase() === "b" && event.shiftKey) {
        event.preventDefault();
        setDockOpen((open) => !open);
      }
      if (
        (event.key === "1" || event.key === "2") &&
        Number(event.key) <= paneIds.length
      ) {
        event.preventDefault();
        setFocusedPane(Number(event.key) - 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const paneThreads = useMemo(
    () =>
      paneIds
        .map((id) => threads.find((thread) => thread.id === id))
        .filter(Boolean) as ThreadRecord[],
    [paneIds, threads],
  );

  if (!api || bootstrapError) {
    return (
      <BootstrapError
        message={bootstrapError || "The desktop API is unavailable."}
        onRetry={() => {
          bootstrapStarted.current = -1;
          setBootstrapAttempt((attempt) => attempt + 1);
        }}
      />
    );
  }
  if (!bootstrap || !settings) return <LoadingShell />;

  return (
    <TooltipProvider delay={350}>
      <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
        <Titlebar
          page={
            settingsOpen
              ? "settings"
              : evolutionOpen
                ? "evolution"
                : "conversation"
          }
          activeThread={draft ? undefined : activeThread}
          draftOpen={Boolean(draft)}
          threads={threads}
          paneIds={draft ? [] : paneIds}
          dockOpen={dockOpen}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
          onAddSplit={(threadId) => {
            if (paneIds.length >= 2) return;
            setPaneIds((current) => [...current, threadId]);
            setFocusedPane(1);
          }}
          onToggleDock={() => setDockOpen((open) => !open)}
        />

        <div className="flex min-h-0 flex-1">
          <Sidebar
            threads={threads}
            draftWorkspaceRoot={draft?.workspaceRoot}
            activeIds={utilityPageOpen || draft ? [] : paneIds}
            evolutionCount={
              evolutionProposals.filter(
                (proposal) => proposal.status === "pending",
              ).length
            }
            creating={creating}
            visible={sidebarOpen}
            mobileOpen={sidebarOpen}
            onMobileClose={() =>
              window.innerWidth <= 860 && setSidebarOpen(false)
            }
            onSelect={selectThread}
            onCreate={() => createThread(false)}
            onCreateInWorkspace={(workspaceRoot) =>
              createThread(false, workspaceRoot)
            }
            unreadThreadIds={threads
              .filter((thread) => thread.unread)
              .map((thread) => thread.id)}
            onUpdate={updateThread}
            onDelete={deleteThread}
            onOpenSettings={() => {
              setEvolutionOpen(false);
              setSettingsOpen(true);
              if (window.innerWidth <= 860) setSidebarOpen(false);
            }}
            onOpenEvolution={() => {
              setSettingsOpen(false);
              setEvolutionOpen(true);
              void loadEvolution();
              if (window.innerWidth <= 860) setSidebarOpen(false);
            }}
          />

          <main className="relative min-w-0 flex-1">
            <div
              className={`h-full min-w-0 ${utilityPageOpen ? "pointer-events-none invisible" : ""}`}
              aria-hidden={utilityPageOpen || undefined}
              inert={utilityPageOpen || undefined}
            >
              <ResizablePanelGroup orientation="horizontal">
                <ResizablePanel id="conversation-workspace" minSize="42%">
                  {draftThread ? (
                    <ThreadPane
                      key={draftThread.id}
                      thread={draftThread}
                      loading={false}
                      focused
                      split={false}
                      providers={settings.providers}
                      permissionMode={settings.permissions.mode}
                      maxContextTokens={settings.maxContextTokens}
                      onFocus={() => undefined}
                      onSend={sendDraftPrompt}
                      onStop={async () => undefined}
                      onSlashCommand={async () => {
                        toast.info(
                          "Context commands are available after the first message.",
                        );
                      }}
                      onProviderChange={async (providerProfileId) => {
                        setDraft(
                          (current) =>
                            current && { ...current, providerProfileId },
                        );
                      }}
                      onPermissionModeChange={(mode) =>
                        patchSettings({ permissions: { mode } })
                      }
                      onSearchWorkspaceFiles={async (_threadId, query) =>
                        api.searchDraftWorkspaceFiles(
                          draftThread.workspaceRoot,
                          query,
                        )
                      }
                      onSaveImageAttachments={async (
                        _threadId,
                        attachments,
                      ) => {
                        const thread = await ensureDraftThread();
                        return api.saveImageAttachments(thread.id, attachments);
                      }}
                      onDisclosureChange={() => undefined}
                      onResolveApproval={resolveApproval}
                      onOpenExternal={(url) => void api.openExternal(url)}
                      onChangeWorkspace={() => void changeDraftWorkspace()}
                    />
                  ) : paneThreads.length ? (
                    paneThreads.length === 1 ? (
                      <ThreadPane
                        thread={paneThreads[0]}
                        timeline={stream.timelines[paneThreads[0].id]}
                        loading={loadingTimelines.has(paneThreads[0].id)}
                        focused
                        split={false}
                        providers={settings.providers}
                        permissionMode={settings.permissions.mode}
                        maxContextTokens={settings.maxContextTokens}
                        onPermissionModeChange={(mode) =>
                          patchSettings({ permissions: { mode } })
                        }
                        onFocus={() => setFocusedPane(0)}
                        onSend={(
                          prompt,
                          displayPrompt,
                          imageAttachments,
                          displayParts,
                        ) =>
                          sendPrompt(
                            paneThreads[0].id,
                            prompt,
                            displayPrompt,
                            imageAttachments,
                            displayParts,
                          )
                        }
                        onSlashCommand={(command) =>
                          runContextCommand(paneThreads[0].id, command)
                        }
                        onSearchWorkspaceFiles={api.searchWorkspaceFiles}
                        onSaveImageAttachments={api.saveImageAttachments}
                        onStop={() => stopRun(paneThreads[0].id)}
                        onProviderChange={async (providerProfileId) => {
                          await updateThread(paneThreads[0].id, {
                            providerProfileId,
                          });
                        }}
                        onDisclosureChange={(runId, disclosure) =>
                          changeDisclosure(paneThreads[0].id, runId, disclosure)
                        }
                        onResolveApproval={resolveApproval}
                        onOpenExternal={(url) => void api.openExternal(url)}
                      />
                    ) : (
                      <ThreadSplitLayout
                        primaryId={paneThreads[0].id}
                        secondaryId={paneThreads[1].id}
                        primary={
                          <ThreadPane
                            thread={paneThreads[0]}
                            timeline={stream.timelines[paneThreads[0].id]}
                            loading={loadingTimelines.has(paneThreads[0].id)}
                            focused={focusedPane === 0}
                            split
                            providers={settings.providers}
                            permissionMode={settings.permissions.mode}
                            maxContextTokens={settings.maxContextTokens}
                            onPermissionModeChange={(mode) =>
                              patchSettings({ permissions: { mode } })
                            }
                            onFocus={() => setFocusedPane(0)}
                            onClose={() => {
                              setPaneIds((current) =>
                                current.filter(
                                  (id) => id !== paneThreads[0].id,
                                ),
                              );
                              setFocusedPane(0);
                            }}
                            onSend={(
                              prompt,
                              displayPrompt,
                              imageAttachments,
                              displayParts,
                            ) =>
                              sendPrompt(
                                paneThreads[0].id,
                                prompt,
                                displayPrompt,
                                imageAttachments,
                                displayParts,
                              )
                            }
                            onSlashCommand={(command) =>
                              runContextCommand(paneThreads[0].id, command)
                            }
                            onSearchWorkspaceFiles={api.searchWorkspaceFiles}
                            onSaveImageAttachments={api.saveImageAttachments}
                            onStop={() => stopRun(paneThreads[0].id)}
                            onProviderChange={async (providerProfileId) => {
                              await updateThread(paneThreads[0].id, {
                                providerProfileId,
                              });
                            }}
                            onDisclosureChange={(runId, disclosure) =>
                              changeDisclosure(
                                paneThreads[0].id,
                                runId,
                                disclosure,
                              )
                            }
                            onResolveApproval={resolveApproval}
                            onOpenExternal={(url) => void api.openExternal(url)}
                          />
                        }
                        secondary={
                          <ThreadPane
                            thread={paneThreads[1]}
                            timeline={stream.timelines[paneThreads[1].id]}
                            loading={loadingTimelines.has(paneThreads[1].id)}
                            focused={focusedPane === 1}
                            split
                            providers={settings.providers}
                            permissionMode={settings.permissions.mode}
                            maxContextTokens={settings.maxContextTokens}
                            onPermissionModeChange={(mode) =>
                              patchSettings({ permissions: { mode } })
                            }
                            onFocus={() => setFocusedPane(1)}
                            onClose={() => {
                              setPaneIds((current) =>
                                current.filter(
                                  (id) => id !== paneThreads[1].id,
                                ),
                              );
                              setFocusedPane(0);
                            }}
                            onSend={(
                              prompt,
                              displayPrompt,
                              imageAttachments,
                              displayParts,
                            ) =>
                              sendPrompt(
                                paneThreads[1].id,
                                prompt,
                                displayPrompt,
                                imageAttachments,
                                displayParts,
                              )
                            }
                            onSlashCommand={(command) =>
                              runContextCommand(paneThreads[1].id, command)
                            }
                            onSearchWorkspaceFiles={api.searchWorkspaceFiles}
                            onSaveImageAttachments={api.saveImageAttachments}
                            onStop={() => stopRun(paneThreads[1].id)}
                            onProviderChange={async (providerProfileId) => {
                              await updateThread(paneThreads[1].id, {
                                providerProfileId,
                              });
                            }}
                            onDisclosureChange={(runId, disclosure) =>
                              changeDisclosure(
                                paneThreads[1].id,
                                runId,
                                disclosure,
                              )
                            }
                            onResolveApproval={resolveApproval}
                            onOpenExternal={(url) => void api.openExternal(url)}
                          />
                        }
                      />
                    )
                  ) : (
                    <div className="flex h-full items-center justify-center px-6 text-center">
                      <div className="max-w-sm -translate-y-5">
                        <div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-2xl border bg-muted/25 text-muted-foreground">
                          <IconSparkles className="size-5" />
                        </div>
                        <h1 className="text-[24px] font-medium tracking-[-0.025em]">
                          Start with a local workspace
                        </h1>
                        <p className="mt-2 text-xs leading-5 text-muted-foreground">
                          Choose a folder to create a coding thread. Walle keeps
                          its sessions and workspace data on this Mac.
                        </p>
                        <Button
                          className="mt-5"
                          onClick={() => void createThread(true)}
                          disabled={creating}
                        >
                          {creating ? (
                            <IconLoader2 className="animate-spin" />
                          ) : (
                            <IconFolderPlus />
                          )}
                          Choose workspace
                        </Button>
                      </div>
                    </div>
                  )}
                </ResizablePanel>

                {dockOpen && activeThread && !draft && (
                  <>
                    <ResizableHandle />
                    <ResizablePanel
                      id="developer-dock"
                      defaultSize="34%"
                      minSize="280px"
                      maxSize="55%"
                    >
                      <DeveloperDock
                        api={api}
                        thread={activeThread}
                        browserEnabled={!utilityPageOpen}
                        onClose={() => setDockOpen(false)}
                      />
                    </ResizablePanel>
                  </>
                )}
              </ResizablePanelGroup>
            </div>

            {settingsOpen && (
              <div className="absolute inset-0 z-10 bg-background">
                <SettingsPage
                  settings={settings}
                  capabilities={bootstrap.capabilities}
                  appVersion={bootstrap.appVersion}
                  platform={bootstrap.platform}
                  api={api}
                  saving={settingsSaving}
                  onBack={() => setSettingsOpen(false)}
                  onPatch={patchSettings}
                  onUpsertProvider={upsertProvider}
                  onDeleteProvider={removeProvider}
                />
              </div>
            )}

            {evolutionOpen && (
              <div className="absolute inset-0 z-10 bg-background">
                <EvolutionInbox
                  proposals={evolutionProposals}
                  loading={evolutionLoading}
                  onBack={() => setEvolutionOpen(false)}
                  onRefresh={loadEvolution}
                  onResolve={resolveEvolution}
                />
              </div>
            )}
          </main>
        </div>

        <Toaster position="bottom-right" />
      </div>
    </TooltipProvider>
  );
}
