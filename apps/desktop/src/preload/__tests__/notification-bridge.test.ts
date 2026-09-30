import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopApi,
  ThreadAttentionEvent,
  ThreadNavigationRequest,
  ThreadStateEvent,
} from "../../shared/contracts";
import { IPC } from "../../shared/contracts";

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  send: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    send: electron.send,
    on: electron.on,
    removeListener: electron.removeListener,
  },
}));

describe("notification preload bridge", () => {
  let api: DesktopApi;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    await import("../index");
    api = electron.exposeInMainWorld.mock.calls.at(-1)?.[1] as DesktopApi;
  });

  it("exposes typed active/read/attention/navigation invokes", async () => {
    electron.invoke.mockResolvedValue(undefined);

    await api.setActiveThreadIds(["thread-1", "thread-2"]);
    await api.markThreadRead("thread-1");
    await api.getPendingThreadAttentions();
    await api.acknowledgeThreadAttention("thread-1", "run-1");
    await api.getPendingThreadNavigation();

    expect(electron.invoke).toHaveBeenNthCalledWith(1, IPC.threadSetActive, [
      "thread-1",
      "thread-2",
    ]);
    expect(electron.invoke).toHaveBeenNthCalledWith(
      2,
      IPC.threadMarkRead,
      "thread-1",
    );
    expect(electron.invoke).toHaveBeenNthCalledWith(
      3,
      IPC.threadPendingAttentions,
    );
    expect(electron.invoke).toHaveBeenNthCalledWith(
      4,
      IPC.threadAttentionAck,
      "thread-1",
      "run-1",
    );
    expect(electron.invoke).toHaveBeenNthCalledWith(
      5,
      IPC.threadPendingNavigation,
    );
  });

  it("routes file search and image saves by thread id rather than renderer paths", async () => {
    electron.invoke.mockResolvedValue([]);
    const attachment = {
      mimeType: "image/png" as const,
      base64: "iVBORw0KGgo=",
    };

    await api.searchWorkspaceFiles("thread-1", "agent");
    await api.saveImageAttachments("thread-1", [attachment]);

    expect(electron.invoke).toHaveBeenNthCalledWith(
      1,
      IPC.workspaceSearchFiles,
      "thread-1",
      "agent",
    );
    expect(electron.invoke).toHaveBeenNthCalledWith(
      2,
      IPC.workspaceSaveImageAttachments,
      "thread-1",
      [attachment],
    );
  });

  it("forwards structured display parts when starting a run", async () => {
    electron.invoke.mockResolvedValue({ runId: "run-1" });
    const parts = [
      { type: "text" as const, text: "Review " },
      {
        type: "file" as const,
        name: "agent.ts",
        relativePath: "src/agent.ts",
      },
    ];

    await api.startRun(
      "thread-1",
      "Review /workspace/src/agent.ts",
      [],
      "Review @[src/agent.ts]",
      parts,
    );

    expect(electron.invoke).toHaveBeenCalledWith(
      IPC.runStart,
      "thread-1",
      "Review /workspace/src/agent.ts",
      [],
      "Review @[src/agent.ts]",
      parts,
    );
  });

  it.each([
    [
      "onThreadAttention",
      IPC.threadAttention,
      {
        threadId: "thread-1",
        runId: "run-1",
        completedAt: "2026-08-10T08:09:10.000Z",
        threadTitle: "Task",
        workspaceName: "workspace",
        delivery: "in-app",
      } satisfies ThreadAttentionEvent,
    ],
    [
      "onThreadNavigation",
      IPC.threadNavigate,
      {
        requestId: "request-1",
        threadId: "thread-1",
        requestedAt: "2026-08-10T08:09:11.000Z",
      } satisfies ThreadNavigationRequest,
    ],
    [
      "onThreadState",
      IPC.threadState,
      {
        reason: "marked-read",
        thread: {
          id: "thread-1",
          sessionId: "session-1",
          title: "Task",
          workspaceRoot: "/workspace",
          workspaceName: "workspace",
          providerProfileId: "provider-1",
          model: "model",
          pinned: false,
          archived: false,
          unread: false,
          status: "idle",
          createdAt: "2026-08-10T08:00:00.000Z",
          updatedAt: "2026-08-10T08:09:10.000Z",
        },
      } satisfies ThreadStateEvent,
    ],
  ] as const)(
    "subscribes and unsubscribes %s with the same wrapper",
    (method, channel, payload) => {
      const listener = vi.fn();
      const unsubscribe = (
        api[method] as (callback: (event: never) => void) => () => void
      )(listener);
      const wrapped = electron.on.mock.calls.at(-1)?.[1] as (
        event: unknown,
        value: unknown,
      ) => void;

      expect(electron.on).toHaveBeenLastCalledWith(channel, wrapped);
      wrapped({}, payload);
      expect(listener).toHaveBeenCalledWith(payload);

      unsubscribe();
      expect(electron.removeListener).toHaveBeenCalledWith(channel, wrapped);
    },
  );
});
