import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ThreadAttentionEvent,
  ThreadNavigationRequest,
  ThreadStateEvent,
} from "../../shared/contracts";
import { DesktopStore } from "../desktop-store";
import {
  NotificationService,
  type SystemNotificationHandle,
} from "../notification-service";
import { ThreadNotificationManager } from "../thread-notification-manager";

type NotificationEvent = "click" | "close" | "failed";

class FakeNotification implements SystemNotificationHandle {
  readonly listeners = new Map<
    NotificationEvent,
    (...args: unknown[]) => void
  >();

  once(event: "click", listener: () => void): this;
  once(event: "close", listener: () => void): this;
  once(
    event: "failed",
    listener: (_event: unknown, error: string) => void,
  ): this;
  once(event: NotificationEvent, listener: (...args: never[]) => void): this {
    this.listeners.set(event, listener as (...args: unknown[]) => void);
    return this;
  }

  show(): void {}

  emit(event: NotificationEvent, ...args: unknown[]): void {
    this.listeners.get(event)?.(...args);
  }
}

describe("ThreadNotificationManager", () => {
  let directory: string;
  let store: DesktopStore;
  let firstId: string;
  let secondId: string;
  let focused: boolean;
  let supported: boolean;
  let notifications: FakeNotification[];
  let attentions: ThreadAttentionEvent[];
  let navigations: ThreadNavigationRequest[];
  let states: ThreadStateEvent[];
  let focusCalls: number;
  let manager: ThreadNotificationManager;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "walle-notifications-"));
    store = new DesktopStore(directory);
    await store.init();
    firstId = (
      await store.createThread({ workspaceRoot: directory, title: "First" })
    ).id;
    secondId = (
      await store.createThread({ workspaceRoot: directory, title: "Second" })
    ).id;
    focused = true;
    supported = true;
    notifications = [];
    attentions = [];
    navigations = [];
    states = [];
    focusCalls = 0;
    manager = new ThreadNotificationManager(
      store,
      new NotificationService({
        isSupported: () => supported,
        create: () => {
          const notification = new FakeNotification();
          notifications.push(notification);
          return notification;
        },
      }),
      {
        isWindowFocused: () => focused,
        focusWindow: () => {
          focusCalls += 1;
          focused = true;
        },
        sendAttention: (event) => attentions.push(event),
        sendNavigation: (event) => navigations.push(event),
        sendThreadState: (event) => states.push(event),
      },
    );
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("suppresses successful completions visible in either active split pane", async () => {
    await store.markThreadUnread(secondId, "2026-08-10T08:00:00.000Z");
    manager.setActiveThreadIds([firstId, secondId]);

    await manager.handleRunCompleted({
      threadId: secondId,
      runId: "run-visible",
      completedAt: "2026-08-10T08:09:10.000Z",
    });

    expect(store.getThread(secondId)?.unread).toBe(false);
    expect(attentions).toEqual([]);
    expect(notifications).toEqual([]);
    expect(states).toEqual([
      expect.objectContaining({
        reason: "marked-read",
        thread: expect.objectContaining({ id: secondId, unread: false }),
      }),
    ]);
  });

  it("marks an inactive completion unread and emits an in-app attention event", async () => {
    manager.setActiveThreadIds([firstId]);

    await manager.handleRunCompleted({
      threadId: secondId,
      runId: "run-background",
      completedAt: "2026-08-10T08:09:10.000Z",
    });

    expect(store.getThread(secondId)).toMatchObject({
      unread: true,
      unreadAt: "2026-08-10T08:09:10.000Z",
    });
    expect(attentions).toEqual([
      expect.objectContaining({
        threadId: secondId,
        runId: "run-background",
        delivery: "in-app",
      }),
    ]);
    expect(states.at(-1)).toMatchObject({
      reason: "run-completed",
      thread: { id: secondId, unread: true },
    });
    expect(notifications).toEqual([]);
  });

  it("retains an in-app attention until the renderer acknowledges it", async () => {
    manager.setActiveThreadIds([firstId]);

    await manager.handleRunCompleted({
      threadId: secondId,
      runId: "run-renderer-reload",
      completedAt: "2026-08-10T08:09:10.000Z",
    });

    // The event sent to a renderer that is loading may be dropped. The query
    // path must still replay the same completion after that renderer is ready.
    attentions.length = 0;
    expect(manager.getPendingAttentions()).toEqual([
      expect.objectContaining({
        threadId: secondId,
        runId: "run-renderer-reload",
      }),
    ]);
    expect(manager.getPendingAttentions()).toHaveLength(1);

    await manager.acknowledgeAttention(secondId, "run-renderer-reload");
    expect(manager.getPendingAttentions()).toEqual([]);
  });

  it("discards pending attention when its task is marked read", async () => {
    manager.setActiveThreadIds([firstId]);
    await manager.handleRunCompleted({
      threadId: secondId,
      runId: "run-opened-before-ack",
      completedAt: "2026-08-10T08:09:10.000Z",
    });

    await manager.markThreadRead(secondId);

    expect(manager.getPendingAttentions()).toEqual([]);
  });

  it("uses a system notification while unfocused even for the active task and navigates on click", async () => {
    focused = false;
    manager.setActiveThreadIds([firstId]);

    await manager.handleRunCompleted({
      threadId: firstId,
      runId: "run-unfocused",
      completedAt: "2026-08-10T08:09:10.000Z",
    });

    expect(store.getThread(firstId)?.unread).toBe(true);
    expect(attentions).toEqual([]);
    expect(notifications).toHaveLength(1);

    notifications[0].emit("click");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(focusCalls).toBe(1);
    expect(navigations).toEqual([
      expect.objectContaining({ threadId: firstId }),
    ]);
    expect(manager.getPendingNavigation()).toMatchObject({ threadId: firstId });

    const markedRead = await manager.markThreadRead(firstId);
    expect(markedRead.unread).toBe(false);
    expect(manager.getPendingNavigation()).toBeNull();
  });

  it("clears unread for active panes on focus while preserving inactive unread", async () => {
    await store.markThreadUnread(firstId, "2026-08-10T08:01:00.000Z");
    await store.markThreadUnread(secondId, "2026-08-10T08:02:00.000Z");
    manager.setActiveThreadIds([firstId]);
    focused = true;

    await manager.handleWindowFocused();

    expect(store.getThread(firstId)?.unread).toBe(false);
    expect(store.getThread(secondId)?.unread).toBe(true);
    expect(states).toContainEqual(
      expect.objectContaining({
        reason: "marked-read",
        thread: expect.objectContaining({ id: firstId, unread: false }),
      }),
    );
  });

  it("defers a failed system notification, but skips the toast when that task is visible on focus", async () => {
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    supported = false;
    focused = false;
    manager.setActiveThreadIds([firstId]);

    await manager.handleRunCompleted({
      threadId: firstId,
      runId: "run-failed-notification",
      completedAt: "2026-08-10T08:09:10.000Z",
    });
    focused = true;
    await manager.handleWindowFocused();

    expect(attentions).toEqual([]);
    expect(store.getThread(firstId)?.unread).toBe(false);
    expect(warning).toHaveBeenCalled();
    warning.mockRestore();
  });

  it("delivers a deferred in-app notice for a still-unread inactive task", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    supported = false;
    focused = false;
    manager.setActiveThreadIds([firstId]);

    await manager.handleRunCompleted({
      threadId: secondId,
      runId: "run-deferred",
      completedAt: "2026-08-10T08:09:10.000Z",
    });
    focused = true;
    await manager.handleWindowFocused();

    expect(attentions).toEqual([
      expect.objectContaining({
        threadId: secondId,
        delivery: "deferred",
      }),
    ]);
    expect(store.getThread(secondId)?.unread).toBe(true);
    expect(manager.getPendingAttentions()).toEqual([
      expect.objectContaining({
        threadId: secondId,
        runId: "run-deferred",
        delivery: "deferred",
      }),
    ]);
    vi.restoreAllMocks();
  });
});
