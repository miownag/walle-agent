import { randomUUID } from "node:crypto";
import type {
  ThreadAttentionEvent,
  ThreadNavigationRequest,
  ThreadRecord,
  ThreadStateEvent,
} from "../shared/contracts";
import type { AgentRunCompleted } from "./agent-manager";
import { DesktopStore } from "./desktop-store";
import { NotificationService } from "./notification-service";

interface ThreadNotificationRuntime {
  isWindowFocused(): boolean;
  focusWindow(): void;
  sendAttention(event: ThreadAttentionEvent): void;
  sendNavigation(event: ThreadNavigationRequest): void;
  sendThreadState(event: ThreadStateEvent): void;
}

export class ThreadNotificationManager {
  private readonly activeThreadIds = new Set<string>();
  private readonly pendingAttention = new Map<string, ThreadAttentionEvent>();
  private readonly deferredAttention = new Map<string, ThreadAttentionEvent>();
  private pendingNavigation: ThreadNavigationRequest | null = null;
  private operations: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: DesktopStore,
    private readonly notifications: NotificationService,
    private readonly runtime: ThreadNotificationRuntime,
  ) {}

  setActiveThreadIds(threadIds: string[]): void {
    this.activeThreadIds.clear();
    for (const threadId of threadIds) {
      if (this.store.getThread(threadId)) this.activeThreadIds.add(threadId);
    }
  }

  handleRunCompleted(completion: AgentRunCompleted): Promise<void> {
    const windowFocused = this.runtime.isWindowFocused();
    const visibleAtCompletion =
      windowFocused && this.activeThreadIds.has(completion.threadId);
    return this.enqueue(async () => {
      const thread = this.store.getThread(completion.threadId);
      if (!thread) return;

      if (visibleAtCompletion) {
        this.discardAttentionsForThread(thread.id);
        if (thread.unread) {
          const updated = await this.store.markThreadRead(thread.id);
          this.runtime.sendThreadState({
            thread: updated,
            reason: "marked-read",
          });
        }
        return;
      }

      const updated = await this.store.markThreadUnread(
        thread.id,
        completion.completedAt,
      );
      this.runtime.sendThreadState({
        thread: updated,
        reason: "run-completed",
      });
      const attention: ThreadAttentionEvent = {
        threadId: updated.id,
        runId: completion.runId,
        completedAt: completion.completedAt,
        threadTitle: updated.title,
        workspaceName: updated.workspaceName,
        delivery: "in-app",
      };

      if (windowFocused) {
        this.deliverInApp(attention);
        return;
      }

      this.notifications.showCompletion(attention, {
        onClick: () => this.handleNotificationClick(updated.id),
        onFailed: (error) => this.deferFailedNotification(attention, error),
      });
    });
  }

  handleWindowFocused(): Promise<void> {
    const visibleThreadIds = new Set(this.activeThreadIds);
    return this.enqueue(async () => {
      for (const [key, attention] of this.deferredAttention) {
        const thread = this.store.getThread(attention.threadId);
        this.deferredAttention.delete(key);
        if (!thread?.unread) continue;
        if (visibleThreadIds.has(attention.threadId)) continue;
        this.deliverInApp({ ...attention, delivery: "deferred" });
      }

      for (const threadId of visibleThreadIds) {
        const thread = this.store.getThread(threadId);
        if (!thread?.unread) continue;
        const updated = await this.store.markThreadRead(threadId);
        this.discardAttentionsForThread(threadId);
        this.runtime.sendThreadState({
          thread: updated,
          reason: "marked-read",
        });
      }
    });
  }

  markThreadRead(threadId: string): Promise<ThreadRecord> {
    return this.enqueueResult(async () => {
      const updated = await this.store.markThreadRead(threadId);
      this.discardAttentionsForThread(threadId);
      if (this.pendingNavigation?.threadId === threadId) {
        this.pendingNavigation = null;
      }
      return updated;
    });
  }

  getPendingAttentions(): ThreadAttentionEvent[] {
    for (const [key, attention] of this.pendingAttention) {
      const thread = this.store.getThread(attention.threadId);
      if (!thread?.unread) this.pendingAttention.delete(key);
    }
    return [...this.pendingAttention.values()].map((attention) =>
      structuredClone(attention),
    );
  }

  acknowledgeAttention(threadId: string, runId: string): Promise<void> {
    return this.enqueue(async () => {
      this.pendingAttention.delete(this.attentionKey(threadId, runId));
    });
  }

  getPendingNavigation(): ThreadNavigationRequest | null {
    if (
      this.pendingNavigation &&
      !this.store.getThread(this.pendingNavigation.threadId)
    ) {
      this.pendingNavigation = null;
    }
    return this.pendingNavigation
      ? structuredClone(this.pendingNavigation)
      : null;
  }

  private handleNotificationClick(threadId: string): void {
    void this.enqueue(async () => {
      if (!this.store.getThread(threadId)) return;
      const request: ThreadNavigationRequest = {
        requestId: randomUUID(),
        threadId,
        requestedAt: new Date().toISOString(),
      };
      this.pendingNavigation = request;
      this.runtime.focusWindow();
      this.runtime.sendNavigation(request);
    });
  }

  private deferFailedNotification(
    attention: ThreadAttentionEvent,
    error: Error,
  ): void {
    void this.enqueue(async () => {
      const thread = this.store.getThread(attention.threadId);
      if (!thread?.unread) return;
      console.warn("System task notification was deferred:", error.message);
      if (this.runtime.isWindowFocused()) {
        if (!this.activeThreadIds.has(attention.threadId)) {
          this.deliverInApp({ ...attention, delivery: "deferred" });
        } else {
          const updated = await this.store.markThreadRead(attention.threadId);
          this.discardAttentionsForThread(attention.threadId);
          this.runtime.sendThreadState({
            thread: updated,
            reason: "marked-read",
          });
        }
      } else {
        this.deferredAttention.set(
          this.attentionKey(attention.threadId, attention.runId),
          attention,
        );
      }
    });
  }

  private deliverInApp(attention: ThreadAttentionEvent): void {
    this.pendingAttention.set(
      this.attentionKey(attention.threadId, attention.runId),
      attention,
    );
    this.runtime.sendAttention(attention);
  }

  private discardAttentionsForThread(threadId: string): void {
    for (const [key, attention] of this.pendingAttention) {
      if (attention.threadId === threadId) this.pendingAttention.delete(key);
    }
    for (const [key, attention] of this.deferredAttention) {
      if (attention.threadId === threadId) this.deferredAttention.delete(key);
    }
  }

  private attentionKey(threadId: string, runId: string): string {
    return JSON.stringify([threadId, runId]);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const current = this.operations.catch(() => undefined).then(operation);
    this.operations = current.catch(() => undefined);
    return current;
  }

  private enqueueResult<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.operations.catch(() => undefined).then(operation);
    this.operations = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }
}
