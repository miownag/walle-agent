import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ThemeProvider } from "next-themes";
import { toast } from "sonner";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "../../main/defaults";
import type {
  DesktopApi,
  ThreadAttentionEvent,
  ThreadNavigationRequest,
  ThreadRecord,
} from "@shared/contracts";
import { App } from "./app";

class ResizeObserverStub implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverStub,
  });
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [new DOMRect()],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  });
});

function threadNotificationApi(threads: ThreadRecord[] = []) {
  return {
    setActiveThreadIds: vi.fn().mockResolvedValue(undefined),
    markThreadRead: vi.fn(async (threadId: string) => {
      const thread = threads.find((item) => item.id === threadId);
      if (!thread) throw new Error(`Unknown thread: ${threadId}`);
      return { ...thread, unread: false, unreadAt: undefined };
    }),
    getPendingThreadAttentions: vi.fn().mockResolvedValue([]),
    acknowledgeThreadAttention: vi.fn().mockResolvedValue(undefined),
    getPendingThreadNavigation: vi.fn().mockResolvedValue(null),
    onThreadAttention: vi.fn(() => () => undefined),
    onThreadNavigation: vi.fn(() => () => undefined),
    onThreadState: vi.fn(() => () => undefined),
  };
}

describe("App settings navigation", () => {
  it("opens Settings from the app sidebar, hides the browser view, and returns", async () => {
    const hideBrowser = vi.fn().mockResolvedValue(undefined);
    const api = {
      ...threadNotificationApi(),
      bootstrap: vi.fn().mockResolvedValue({
        settings: structuredClone(DEFAULT_SETTINGS),
        threads: [],
        capabilities: [],
        platform: "darwin",
        appVersion: "0.1.0",
      }),
      listEvolutionProposals: vi.fn().mockResolvedValue([]),
      onAgentEvent: vi.fn(() => () => undefined),
      hideBrowser,
      listSkills: vi.fn().mockResolvedValue([]),
    } as unknown as DesktopApi;
    Object.defineProperty(window, "walle", { configurable: true, value: api });

    render(
      <ThemeProvider attribute="class" defaultTheme="light">
        <App />
      </ThemeProvider>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Open settings" }),
    );

    expect(
      await screen.findByRole("region", { name: "Walle settings" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Walle settings" }),
    ).not.toBeInTheDocument();
    expect(document.querySelector("header")).toHaveAttribute(
      "data-page",
      "settings",
    );
    expect(
      screen.getByRole("button", { name: "Open settings" }),
    ).not.toHaveAttribute("aria-current");
    expect(
      screen.queryByRole("button", { name: "Split conversation" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open developer dock" }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(hideBrowser).toHaveBeenCalled());

    fireEvent.click(
      screen.getByRole("button", { name: "Back to conversations" }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("region", { name: "Walle settings" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Start with a local workspace" }),
      ).toBeInTheDocument();
      expect(document.querySelector("header")).toHaveAttribute(
        "data-page",
        "conversation",
      );
      expect(
        screen.getByRole("button", { name: "Open settings" }),
      ).not.toHaveAttribute("aria-current");
    });
  });

  it("opens Evolution inbox as a full page and returns to conversations", async () => {
    const hideBrowser = vi.fn().mockResolvedValue(undefined);
    const api = {
      ...threadNotificationApi(),
      bootstrap: vi.fn().mockResolvedValue({
        settings: structuredClone(DEFAULT_SETTINGS),
        threads: [],
        capabilities: [],
        platform: "darwin",
        appVersion: "0.1.0",
      }),
      listEvolutionProposals: vi.fn().mockResolvedValue([
        {
          id: "proposal-one",
          type: "memory",
          reason: "periodic_review",
          status: "pending",
          title: "Keep focused tests close to the change",
          content: "Run focused tests before the complete desktop suite.",
          confidence: 0.9,
          createdAt: "2026-08-10T08:00:00.000Z",
        },
      ]),
      onAgentEvent: vi.fn(() => () => undefined),
      hideBrowser,
      listSkills: vi.fn().mockResolvedValue([]),
    } as unknown as DesktopApi;
    Object.defineProperty(window, "walle", { configurable: true, value: api });

    render(
      <ThemeProvider attribute="class" defaultTheme="light">
        <App />
      </ThemeProvider>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /^Evolution inbox/ }),
    );

    expect(
      await screen.findByRole("region", { name: "Evolution inbox" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.querySelector("header")).toHaveAttribute(
      "data-page",
      "evolution",
    );
    expect(
      screen.queryByRole("button", { name: "Split conversation" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open developer dock" }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(hideBrowser).toHaveBeenCalled());

    fireEvent.click(
      screen.getByRole("button", { name: "Back to conversations" }),
    );
    expect(
      await screen.findByRole("heading", {
        name: "Start with a local workspace",
      }),
    ).toBeInTheDocument();
    expect(document.querySelector("header")).toHaveAttribute(
      "data-page",
      "conversation",
    );
  });

  it("returns to conversations when selecting or creating a thread from Settings", async () => {
    const thread: ThreadRecord = {
      id: "thread-one",
      sessionId: "session-one",
      title: "Existing conversation",
      workspaceRoot: "/repo",
      workspaceName: "repo",
      providerProfileId: "provider-one",
      model: "model-one",
      pinned: false,
      archived: false,
      unread: false,
      status: "idle",
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    };
    const createdThread: ThreadRecord = {
      ...thread,
      id: "thread-two",
      sessionId: "session-two",
      title: "New conversation",
      updatedAt: "2026-08-10T00:01:00.000Z",
    };
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.providers = [
      {
        id: "provider-one",
        name: "Provider",
        kind: "openai",
        model: "model-one",
        hasApiKey: true,
        isDefault: true,
      },
    ];
    const createThread = vi.fn().mockResolvedValue(createdThread);
    const api = {
      ...threadNotificationApi([thread, createdThread]),
      bootstrap: vi.fn().mockResolvedValue({
        settings,
        threads: [thread],
        capabilities: [],
        platform: "darwin",
        appVersion: "0.1.0",
      }),
      getTimeline: vi.fn((threadId: string) =>
        Promise.resolve({ version: 1, threadId, items: [] }),
      ),
      createThread,
      pickWorkspace: vi.fn().mockResolvedValue("/another-repo"),
      listEvolutionProposals: vi.fn().mockResolvedValue([]),
      onAgentEvent: vi.fn(() => () => undefined),
      hideBrowser: vi.fn().mockResolvedValue(undefined),
      listSkills: vi.fn().mockResolvedValue([]),
    } as unknown as DesktopApi;
    Object.defineProperty(window, "walle", { configurable: true, value: api });

    render(
      <ThemeProvider attribute="class" defaultTheme="light">
        <App />
      </ThemeProvider>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Open settings" }),
    );
    expect(
      await screen.findByRole("region", { name: "Walle settings" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /^Existing conversation\b/ }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Walle settings" }),
      ).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(
      await screen.findByRole("region", { name: "Walle settings" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("region", { name: "Walle settings" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "What should we build in repo?" }),
      ).toBeInTheDocument();
    });
    expect(createThread).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: /^New conversation\b/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Change workspace, current repo" }),
    );
    expect(
      await screen.findByRole("heading", {
        name: "What should we build in another-repo?",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Collapse another-repo workspace" }),
    ).toBeInTheDocument();
    expect(createThread).not.toHaveBeenCalled();
  });

  it("creates a task from the workspace row instead of the selected workspace", async () => {
    const selected: ThreadRecord = {
      id: "thread-selected",
      sessionId: "session-selected",
      title: "Selected task",
      workspaceRoot: "/repo-a",
      workspaceName: "repo-a",
      providerProfileId: "provider-a",
      model: "model-a",
      pinned: false,
      archived: false,
      unread: false,
      status: "idle",
      createdAt: "2026-08-10T00:02:00.000Z",
      updatedAt: "2026-08-10T00:02:00.000Z",
    };
    const background: ThreadRecord = {
      ...selected,
      id: "thread-background",
      sessionId: "session-background",
      title: "Background task",
      workspaceRoot: "/repo-b",
      workspaceName: "repo-b",
      providerProfileId: "provider-b",
      model: "model-b",
      createdAt: "2026-08-10T00:01:00.000Z",
      updatedAt: "2026-08-10T00:01:00.000Z",
    };
    const created: ThreadRecord = {
      ...background,
      id: "thread-created",
      sessionId: "session-created",
      title: "New task",
      createdAt: "2026-08-10T00:03:00.000Z",
      updatedAt: "2026-08-10T00:03:00.000Z",
    };
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.providers = [
      {
        id: "provider-a",
        name: "Provider A",
        kind: "openai",
        model: "model-a",
        hasApiKey: true,
        isDefault: true,
      },
      {
        id: "provider-b",
        name: "Provider B",
        kind: "anthropic",
        model: "model-b",
        hasApiKey: true,
        isDefault: false,
      },
    ];
    const createThread = vi.fn().mockResolvedValue(created);
    const api = {
      ...threadNotificationApi([selected, background, created]),
      bootstrap: vi.fn().mockResolvedValue({
        settings,
        threads: [selected, background],
        capabilities: [],
        platform: "darwin",
        appVersion: "0.1.0",
      }),
      getTimeline: vi.fn((threadId: string) =>
        Promise.resolve({ version: 1, threadId, items: [] }),
      ),
      createThread,
      startRun: vi.fn().mockResolvedValue({ runId: "run-new" }),
      listEvolutionProposals: vi.fn().mockResolvedValue([]),
      onAgentEvent: vi.fn(() => () => undefined),
      hideBrowser: vi.fn().mockResolvedValue(undefined),
      listSkills: vi.fn().mockResolvedValue([]),
    } as unknown as DesktopApi;
    Object.defineProperty(window, "walle", { configurable: true, value: api });

    render(
      <ThemeProvider attribute="class" defaultTheme="light">
        <App />
      </ThemeProvider>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "New task in repo-b" }),
    );

    expect(
      await screen.findByRole("heading", {
        name: "What should we build in repo-b?",
      }),
    ).toBeInTheDocument();
    expect(createThread).not.toHaveBeenCalled();
    const editor = screen.getByLabelText("Message Walle");
    fireEvent.paste(editor, {
      clipboardData: {
        items: [],
        files: [],
        types: ["text/plain"],
        getData: (type: string) =>
          type === "text/plain" ? "Build a feature" : "",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(createThread).toHaveBeenCalledWith({
        workspaceRoot: "/repo-b",
        providerProfileId: "provider-b",
        model: "model-b",
      }),
    );
  });

  it("shows a blue unread marker for a completed background task and clears it when opened", async () => {
    const active: ThreadRecord = {
      id: "thread-active",
      sessionId: "session-active",
      title: "Active task",
      workspaceRoot: "/repo",
      workspaceName: "repo",
      providerProfileId: "provider-one",
      model: "model-one",
      pinned: false,
      archived: false,
      unread: false,
      status: "idle",
      createdAt: "2026-08-10T00:02:00.000Z",
      updatedAt: "2026-08-10T00:02:00.000Z",
    };
    const background: ThreadRecord = {
      ...active,
      id: "thread-background",
      sessionId: "session-background",
      title: "Background task",
      createdAt: "2026-08-10T00:01:00.000Z",
      updatedAt: "2026-08-10T00:01:00.000Z",
    };
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.providers = [
      {
        id: "provider-one",
        name: "Provider",
        kind: "openai",
        model: "model-one",
        hasApiKey: true,
        isDefault: true,
      },
    ];
    let attentionListener: ((event: ThreadAttentionEvent) => void) | undefined;
    let resolvePendingAttentions!: (events: ThreadAttentionEvent[]) => void;
    const pendingAttentions = new Promise<ThreadAttentionEvent[]>((resolve) => {
      resolvePendingAttentions = resolve;
    });
    const notifications = threadNotificationApi([active, background]);
    const api = {
      ...notifications,
      bootstrap: vi.fn().mockResolvedValue({
        settings,
        threads: [active, background],
        capabilities: [],
        platform: "darwin",
        appVersion: "0.1.0",
      }),
      getTimeline: vi.fn((threadId: string) =>
        Promise.resolve({ version: 1, threadId, items: [] }),
      ),
      listEvolutionProposals: vi.fn().mockResolvedValue([]),
      onAgentEvent: vi.fn(() => () => undefined),
      onThreadAttention: vi.fn((listener) => {
        attentionListener = listener;
        return () => undefined;
      }),
      getPendingThreadAttentions: vi.fn(() => pendingAttentions),
      hideBrowser: vi.fn().mockResolvedValue(undefined),
      listSkills: vi.fn().mockResolvedValue([]),
    } as unknown as DesktopApi;
    Object.defineProperty(window, "walle", { configurable: true, value: api });

    render(
      <ThemeProvider attribute="class" defaultTheme="light">
        <App />
      </ThemeProvider>,
    );

    await screen.findByRole("button", { name: /^Background task\b/ });
    const attention: ThreadAttentionEvent = {
      threadId: background.id,
      runId: "run-background",
      completedAt: "2026-08-10T00:03:00.000Z",
      threadTitle: background.title,
      workspaceName: background.workspaceName,
      delivery: "in-app",
    };
    act(() => {
      attentionListener?.(attention);
    });

    const unreadButton = await screen.findByRole("button", {
      name: /Background task Unread/,
    });
    expect(
      unreadButton.querySelector('[data-slot="thread-status-dot"]'),
    ).toHaveAttribute("data-unread", "true");
    expect(await screen.findByText("Task completed")).toBeInTheDocument();

    // A pending query can resolve after the same live IPC event. It must be
    // acknowledged again safely without rendering a duplicate toast.
    await act(async () => {
      resolvePendingAttentions([attention]);
      await pendingAttentions;
    });
    await waitFor(() =>
      expect(notifications.acknowledgeThreadAttention).toHaveBeenCalledWith(
        background.id,
        "run-background",
      ),
    );
    expect(screen.getAllByText("Task completed")).toHaveLength(1);

    fireEvent.click(unreadButton);
    await waitFor(() => {
      expect(notifications.markThreadRead).toHaveBeenCalledWith(background.id);
      expect(
        screen.queryByRole("button", { name: /Background task Unread/ }),
      ).not.toBeInTheDocument();
    });
  });

  it("does not let a stale pending navigation override a newer live request", async () => {
    const initial: ThreadRecord = {
      id: "thread-initial",
      sessionId: "session-initial",
      title: "Initial task",
      workspaceRoot: "/repo",
      workspaceName: "repo",
      providerProfileId: "provider-one",
      model: "model-one",
      pinned: false,
      archived: false,
      unread: false,
      status: "idle",
      createdAt: "2026-08-10T00:03:00.000Z",
      updatedAt: "2026-08-10T00:03:00.000Z",
    };
    const liveTarget: ThreadRecord = {
      ...initial,
      id: "thread-live",
      sessionId: "session-live",
      title: "Live target",
      createdAt: "2026-08-10T00:02:00.000Z",
      updatedAt: "2026-08-10T00:02:00.000Z",
    };
    const staleTarget: ThreadRecord = {
      ...initial,
      id: "thread-stale",
      sessionId: "session-stale",
      title: "Stale target",
      createdAt: "2026-08-10T00:01:00.000Z",
      updatedAt: "2026-08-10T00:01:00.000Z",
    };
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.providers = [
      {
        id: "provider-one",
        name: "Provider",
        kind: "openai",
        model: "model-one",
        hasApiKey: true,
        isDefault: true,
      },
    ];
    let navigationListener:
      | ((request: ThreadNavigationRequest) => void)
      | undefined;
    let resolvePendingNavigation!: (
      request: ThreadNavigationRequest | null,
    ) => void;
    const pendingNavigation = new Promise<ThreadNavigationRequest | null>(
      (resolve) => {
        resolvePendingNavigation = resolve;
      },
    );
    const notifications = threadNotificationApi([
      initial,
      liveTarget,
      staleTarget,
    ]);
    const api = {
      ...notifications,
      bootstrap: vi.fn().mockResolvedValue({
        settings,
        threads: [initial, liveTarget, staleTarget],
        capabilities: [],
        platform: "darwin",
        appVersion: "0.1.0",
      }),
      getTimeline: vi.fn((threadId: string) =>
        Promise.resolve({ version: 1, threadId, items: [] }),
      ),
      getPendingThreadNavigation: vi.fn(() => pendingNavigation),
      onThreadNavigation: vi.fn((listener) => {
        navigationListener = listener;
        return () => undefined;
      }),
      listEvolutionProposals: vi.fn().mockResolvedValue([]),
      onAgentEvent: vi.fn(() => () => undefined),
      hideBrowser: vi.fn().mockResolvedValue(undefined),
      listSkills: vi.fn().mockResolvedValue([]),
    } as unknown as DesktopApi;
    Object.defineProperty(window, "walle", { configurable: true, value: api });

    render(
      <ThemeProvider attribute="class" defaultTheme="light">
        <App />
      </ThemeProvider>,
    );

    expect(
      await screen.findByRole("region", { name: "Conversation: Initial task" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(api.onThreadNavigation).toHaveBeenCalled());

    act(() => {
      navigationListener?.({
        requestId: "request-live",
        threadId: liveTarget.id,
        requestedAt: "2026-08-10T08:10:00.000Z",
      });
    });
    expect(
      await screen.findByRole("region", { name: "Conversation: Live target" }),
    ).toBeInTheDocument();

    await act(async () => {
      resolvePendingNavigation({
        requestId: "request-stale",
        threadId: staleTarget.id,
        requestedAt: "2026-08-10T08:09:00.000Z",
      });
      await pendingNavigation;
    });

    expect(
      screen.getByRole("region", { name: "Conversation: Live target" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Conversation: Stale target" }),
    ).not.toBeInTheDocument();
    expect(notifications.markThreadRead).not.toHaveBeenCalledWith(
      staleTarget.id,
    );
    expect(api.onThreadNavigation).toHaveBeenCalledTimes(1);
  });

  it("does not surface a stale visibility failure after switching tasks", async () => {
    const first: ThreadRecord = {
      id: "thread-first",
      sessionId: "session-first",
      title: "First task",
      workspaceRoot: "/repo",
      workspaceName: "repo",
      providerProfileId: "provider-one",
      model: "model-one",
      pinned: false,
      archived: false,
      unread: false,
      status: "idle",
      createdAt: "2026-08-10T00:01:00.000Z",
      updatedAt: "2026-08-10T00:02:00.000Z",
    };
    const second: ThreadRecord = {
      ...first,
      id: "thread-second",
      sessionId: "session-second",
      title: "Second task",
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:01:00.000Z",
    };
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.providers = [
      {
        id: "provider-one",
        name: "Provider",
        kind: "openai",
        model: "model-one",
        hasApiKey: true,
        isDefault: true,
      },
    ];
    let rejectInitialVisibility!: (cause: Error) => void;
    const setActiveThreadIds = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectInitialVisibility = reject;
          }),
      )
      .mockResolvedValue(undefined);
    const api = {
      ...threadNotificationApi([first, second]),
      setActiveThreadIds,
      bootstrap: vi.fn().mockResolvedValue({
        settings,
        threads: [first, second],
        capabilities: [],
        platform: "darwin",
        appVersion: "0.1.0",
      }),
      getTimeline: vi.fn((threadId: string) =>
        Promise.resolve({ version: 1, threadId, items: [] }),
      ),
      listEvolutionProposals: vi.fn().mockResolvedValue([]),
      onAgentEvent: vi.fn(() => () => undefined),
      hideBrowser: vi.fn().mockResolvedValue(undefined),
      listSkills: vi.fn().mockResolvedValue([]),
    } as unknown as DesktopApi;
    Object.defineProperty(window, "walle", { configurable: true, value: api });
    const toastError = vi.spyOn(toast, "error");

    render(
      <ThemeProvider attribute="class" defaultTheme="light">
        <App />
      </ThemeProvider>,
    );

    await waitFor(() =>
      expect(setActiveThreadIds).toHaveBeenCalledWith([first.id]),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /^Second task\b/ }),
    );
    await waitFor(() =>
      expect(setActiveThreadIds).toHaveBeenCalledWith([second.id]),
    );

    await act(async () => {
      rejectInitialVisibility(new Error("Unknown thread"));
      await Promise.resolve();
    });

    expect(toastError).not.toHaveBeenCalledWith(
      "Could not update task visibility",
      expect.anything(),
    );
    toastError.mockRestore();
  });

  it("does not hydrate an old timeline after clear resets the context", async () => {
    const thread: ThreadRecord = {
      id: "thread-clear-race",
      sessionId: "session-before-clear",
      title: "Clear race task",
      workspaceRoot: "/repo",
      workspaceName: "repo",
      providerProfileId: "provider-one",
      model: "model-one",
      pinned: false,
      archived: false,
      unread: false,
      status: "idle",
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    };
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.providers = [
      {
        id: "provider-one",
        name: "Provider",
        kind: "openai",
        model: "model-one",
        hasApiKey: true,
        isDefault: true,
      },
    ];
    let resolveOldTimeline!: (timeline: {
      version: 1;
      threadId: string;
      items: Array<{
        id: string;
        type: "user";
        content: string;
        createdAt: string;
      }>;
    }) => void;
    const oldTimeline = new Promise<{
      version: 1;
      threadId: string;
      items: Array<{
        id: string;
        type: "user";
        content: string;
        createdAt: string;
      }>;
    }>((resolve) => {
      resolveOldTimeline = resolve;
    });
    const clearContext = vi.fn().mockResolvedValue({
      thread: {
        ...thread,
        sessionId: "session-after-clear",
        updatedAt: "2026-08-10T00:01:00.000Z",
      },
      timeline: { version: 1, threadId: thread.id, items: [] },
    });
    const api = {
      ...threadNotificationApi([thread]),
      bootstrap: vi.fn().mockResolvedValue({
        settings,
        threads: [thread],
        capabilities: [],
        platform: "darwin",
        appVersion: "0.1.0",
      }),
      getTimeline: vi.fn(() => oldTimeline),
      clearContext,
      listEvolutionProposals: vi.fn().mockResolvedValue([]),
      onAgentEvent: vi.fn(() => () => undefined),
      hideBrowser: vi.fn().mockResolvedValue(undefined),
      listSkills: vi.fn().mockResolvedValue([]),
    } as unknown as DesktopApi;
    Object.defineProperty(window, "walle", { configurable: true, value: api });

    render(
      <ThemeProvider attribute="class" defaultTheme="light">
        <App />
      </ThemeProvider>,
    );

    const textarea = await screen.findByLabelText("Message Walle");
    await waitFor(() =>
      expect(api.getTimeline).toHaveBeenCalledWith(thread.id),
    );
    fireEvent.paste(textarea, {
      clipboardData: {
        items: [],
        files: [],
        types: ["text/plain"],
        getData: (type: string) => (type === "text/plain" ? "/clear" : ""),
      },
    });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(clearContext).toHaveBeenCalledWith(thread.id));
    expect(
      await screen.findByRole("heading", {
        name: "What should we build in repo?",
      }),
    ).toBeInTheDocument();

    await act(async () => {
      resolveOldTimeline({
        version: 1,
        threadId: thread.id,
        items: [
          {
            id: "old-message",
            type: "user",
            content: "Old context must stay cleared",
            createdAt: "2026-08-10T00:00:30.000Z",
          },
        ],
      });
      await oldTimeline;
      await Promise.resolve();
    });

    expect(
      screen.queryByText("Old context must stay cleared"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "What should we build in repo?" }),
    ).toBeInTheDocument();
  });
});
