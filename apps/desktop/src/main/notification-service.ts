import type { ThreadAttentionEvent } from "../shared/contracts";

export interface SystemNotificationOptions {
  title: string;
  body: string;
  silent: boolean;
}

export interface SystemNotificationHandle {
  once(event: "click", listener: () => void): this;
  once(event: "close", listener: () => void): this;
  once(
    event: "failed",
    listener: (_event: unknown, error: string) => void,
  ): this;
  show(): void;
}

export interface SystemNotificationAdapter {
  isSupported(): boolean;
  create(options: SystemNotificationOptions): SystemNotificationHandle;
}

interface CompletionNotificationHandlers {
  onClick(): void;
  onFailed(error: Error): void;
}

function safeLabel(value: string, fallback: string): string {
  const label = value
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 72);
  return label || fallback;
}

/**
 * Owns Electron Notification instances until they settle. On macOS an
 * unreferenced notification can otherwise be collected before its click
 * callback is delivered.
 */
export class NotificationService {
  private readonly live = new Set<SystemNotificationHandle>();

  constructor(private readonly adapter: SystemNotificationAdapter) {}

  showCompletion(
    event: ThreadAttentionEvent,
    handlers: CompletionNotificationHandlers,
  ): void {
    let supported = false;
    try {
      supported = this.adapter.isSupported();
    } catch (error) {
      handlers.onFailed(
        error instanceof Error ? error : new Error(String(error)),
      );
      return;
    }
    if (!supported) {
      handlers.onFailed(new Error("System notifications are unavailable"));
      return;
    }

    let notification: SystemNotificationHandle;
    try {
      notification = this.adapter.create({
        title: "Walle task completed",
        body: `${safeLabel(event.threadTitle, "Task")} · ${safeLabel(
          event.workspaceName,
          "Local workspace",
        )}`,
        silent: false,
      });
    } catch (error) {
      handlers.onFailed(
        error instanceof Error ? error : new Error(String(error)),
      );
      return;
    }

    this.live.add(notification);
    let settled = false;
    const release = (): void => {
      this.live.delete(notification);
    };
    notification.once("click", () => {
      if (settled) return;
      settled = true;
      release();
      handlers.onClick();
    });
    notification.once("close", () => {
      if (settled) return;
      settled = true;
      release();
    });
    notification.once("failed", (_event, message) => {
      if (settled) return;
      settled = true;
      release();
      handlers.onFailed(new Error(message || "System notification failed"));
    });

    try {
      notification.show();
    } catch (error) {
      if (settled) return;
      settled = true;
      release();
      handlers.onFailed(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  get activeCount(): number {
    return this.live.size;
  }
}
