import { describe, expect, it, vi } from "vitest";
import type { ThreadAttentionEvent } from "../../shared/contracts";
import {
  NotificationService,
  type SystemNotificationAdapter,
  type SystemNotificationHandle,
  type SystemNotificationOptions,
} from "../notification-service";

type NotificationEvent = "click" | "close" | "failed";

class FakeNotification implements SystemNotificationHandle {
  readonly listeners = new Map<
    NotificationEvent,
    (...args: unknown[]) => void
  >();
  shown = false;

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

  show(): void {
    this.shown = true;
  }

  emit(event: NotificationEvent, ...args: unknown[]): void {
    this.listeners.get(event)?.(...args);
  }
}

function attention(): ThreadAttentionEvent {
  return {
    threadId: "thread-1",
    runId: "run-1",
    completedAt: "2026-08-10T08:09:10.000Z",
    threadTitle: `Fix\nlogin\u0000\u202e${"x".repeat(100)}`,
    workspaceName: "walle\tagent",
    delivery: "in-app",
  };
}

describe("NotificationService", () => {
  it("uses only sanitized task/workspace labels and retains the instance until click", () => {
    const handle = new FakeNotification();
    let options: SystemNotificationOptions | undefined;
    const adapter: SystemNotificationAdapter = {
      isSupported: () => true,
      create: (value) => {
        options = value;
        return handle;
      },
    };
    const service = new NotificationService(adapter);
    const onClick = vi.fn();
    const onFailed = vi.fn();

    service.showCompletion(attention(), { onClick, onFailed });

    expect(handle.shown).toBe(true);
    expect(service.activeCount).toBe(1);
    expect(options).toEqual({
      title: "Walle task completed",
      body: `${`Fix login ${"x".repeat(62)}`} · walle agent`,
      silent: false,
    });
    expect(JSON.stringify(options)).not.toContain("finalAnswer");

    handle.emit("click");
    expect(onClick).toHaveBeenCalledOnce();
    expect(onFailed).not.toHaveBeenCalled();
    expect(service.activeCount).toBe(0);
    handle.emit("failed", {}, "late failure");
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("reports unsupported and failed notifications without retaining them", () => {
    const unsupportedFailure = vi.fn();
    const unsupported = new NotificationService({
      isSupported: () => false,
      create: () => new FakeNotification(),
    });
    unsupported.showCompletion(attention(), {
      onClick: vi.fn(),
      onFailed: unsupportedFailure,
    });
    expect(unsupportedFailure).toHaveBeenCalledOnce();
    expect(unsupported.activeCount).toBe(0);

    const closedHandle = new FakeNotification();
    const closed = new NotificationService({
      isSupported: () => true,
      create: () => closedHandle,
    });
    closed.showCompletion(attention(), {
      onClick: vi.fn(),
      onFailed: vi.fn(),
    });
    expect(closed.activeCount).toBe(1);
    closedHandle.emit("close");
    expect(closed.activeCount).toBe(0);

    const handle = new FakeNotification();
    const failure = vi.fn();
    const service = new NotificationService({
      isSupported: () => true,
      create: () => handle,
    });
    service.showCompletion(attention(), {
      onClick: vi.fn(),
      onFailed: failure,
    });
    handle.emit("failed", {}, "unsigned development build");
    expect(failure).toHaveBeenCalledWith(
      expect.objectContaining({ message: "unsigned development build" }),
    );
    expect(service.activeCount).toBe(0);
  });
});
