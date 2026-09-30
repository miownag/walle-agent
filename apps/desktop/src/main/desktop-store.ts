import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type {
  AppSettings,
  AssistantTimelineItem,
  ContextWindowSnapshot,
  CreateThreadInput,
  DeepPartial,
  ThreadRecord,
  ThreadTimeline,
  TimelineItem,
  UpdateThreadInput,
  UserMessagePart,
} from "../shared/contracts";
import { DEFAULT_SETTINGS, mergeSettings, normalizeSettings } from "./defaults";

interface DesktopStateV1 {
  version: 1;
  contextBudgetDefaultVersion: 2;
  settings: AppSettings;
  threads: ThreadRecord[];
  timelines: Record<string, ThreadTimeline>;
}

const EMPTY_STATE: DesktopStateV1 = {
  version: 1,
  contextBudgetDefaultVersion: 2,
  settings: DEFAULT_SETTINGS,
  threads: [],
  timelines: {},
};

function copy<T>(value: T): T {
  return structuredClone(value);
}

function normalizedTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function normalizeContextWindow(value: unknown): ContextWindowSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const usedTokens = normalizedTokenCount(candidate.usedTokens);
  const inputTokens = normalizedTokenCount(candidate.inputTokens);
  const outputTokens = normalizedTokenCount(candidate.outputTokens);
  if (
    usedTokens === undefined ||
    inputTokens === undefined ||
    outputTokens === undefined ||
    (candidate.source !== "provider" &&
      candidate.source !== "estimated-history") ||
    typeof candidate.updatedAt !== "string" ||
    Number.isNaN(Date.parse(candidate.updatedAt))
  ) {
    return null;
  }
  const maxTokens = normalizedTokenCount(candidate.maxTokens);
  const cacheReadTokens = normalizedTokenCount(candidate.cacheReadTokens);
  const cacheWriteTokens = normalizedTokenCount(candidate.cacheWriteTokens);
  return {
    usedTokens,
    inputTokens,
    outputTokens,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    source: candidate.source,
    updatedAt: candidate.updatedAt,
  };
}

function normalizeThread(value: unknown): ThreadRecord | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ThreadRecord>;
  if (!candidate.id || !candidate.sessionId || !candidate.workspaceRoot)
    return null;
  const now = new Date().toISOString();
  return {
    id: candidate.id,
    sessionId: candidate.sessionId,
    title: candidate.title || "New task",
    workspaceRoot: candidate.workspaceRoot,
    workspaceName: candidate.workspaceName || basename(candidate.workspaceRoot),
    providerProfileId: candidate.providerProfileId || "",
    model: candidate.model || "",
    pinned: Boolean(candidate.pinned),
    archived: Boolean(candidate.archived),
    unread: Boolean(candidate.unread),
    unreadAt: candidate.unread
      ? typeof candidate.unreadAt === "string"
        ? candidate.unreadAt
        : candidate.updatedAt || now
      : undefined,
    status: candidate.status === "error" ? "error" : "idle",
    createdAt: candidate.createdAt || now,
    updatedAt: candidate.updatedAt || now,
    lastMessage: candidate.lastMessage,
  };
}

function normalizeTimelineItem(value: unknown): TimelineItem | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "user") {
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.content !== "string"
    )
      return null;
    let textLength = 0;
    const parts = Array.isArray(candidate.parts)
      ? candidate.parts
          .slice(0, 128)
          .map((part): UserMessagePart | null => {
            if (!part || typeof part !== "object" || Array.isArray(part)) {
              return null;
            }
            const entry = part as Record<string, unknown>;
            if (entry.type === "text" && typeof entry.text === "string") {
              textLength += entry.text.length;
              if (textLength > 2_000_000) return null;
              return { type: "text", text: entry.text };
            }
            if (
              entry.type === "file" &&
              typeof entry.name === "string" &&
              entry.name.length > 0 &&
              entry.name.length <= 512 &&
              typeof entry.relativePath === "string" &&
              entry.relativePath.length > 0 &&
              entry.relativePath.length <= 16_384 &&
              !entry.relativePath.includes("\0") &&
              !isAbsolute(entry.relativePath) &&
              !/^[a-z]:[\\/]/i.test(entry.relativePath) &&
              !entry.relativePath.split(/[\\/]/).includes("..")
            ) {
              return {
                type: "file",
                name: entry.name,
                relativePath: entry.relativePath,
              };
            }
            return null;
          })
          .filter((part): part is UserMessagePart => Boolean(part))
      : undefined;
    return {
      id: candidate.id,
      type: "user",
      content: candidate.content,
      ...(parts?.length ? { parts } : {}),
      createdAt:
        typeof candidate.createdAt === "string"
          ? candidate.createdAt
          : new Date().toISOString(),
    };
  }
  if (
    candidate.type !== "assistant" ||
    typeof candidate.id !== "string" ||
    typeof candidate.runId !== "string"
  )
    return null;
  const wasRunning = candidate.status === "running";
  const now = new Date().toISOString();
  const steps = Array.isArray(candidate.steps)
    ? candidate.steps
        .filter(
          (step): step is Record<string, unknown> =>
            Boolean(step) && typeof step === "object",
        )
        .map((step) => {
          if (
            !wasRunning ||
            (step.status !== "running" && step.status !== "pending")
          )
            return step;
          return { ...step, status: "cancelled", completedAt: now };
        })
    : [];
  const normalized: AssistantTimelineItem = {
    ...(candidate as unknown as AssistantTimelineItem),
    id: candidate.id,
    type: "assistant",
    runId: candidate.runId,
    status: wasRunning
      ? "cancelled"
      : candidate.status === "completed" ||
          candidate.status === "cancelled" ||
          candidate.status === "error"
        ? candidate.status
        : "error",
    createdAt:
      typeof candidate.createdAt === "string" ? candidate.createdAt : now,
    completedAt: wasRunning
      ? now
      : typeof candidate.completedAt === "string"
        ? candidate.completedAt
        : undefined,
    steps: steps as unknown as AssistantTimelineItem["steps"],
    finalAnswer:
      typeof candidate.finalAnswer === "string" ? candidate.finalAnswer : "",
    draftAnswer: wasRunning
      ? ""
      : typeof candidate.draftAnswer === "string"
        ? candidate.draftAnswer
        : "",
    processDisclosure:
      wasRunning && !candidate.processUserOverride
        ? "expanded"
        : candidate.processDisclosure === "expanded" ||
            candidate.processDisclosure === "collapsed"
          ? candidate.processDisclosure
          : "auto",
    processUserOverride: Boolean(candidate.processUserOverride),
    error: wasRunning
      ? "Walle was closed before this run finished."
      : typeof candidate.error === "string"
        ? candidate.error
        : undefined,
  };
  return normalized;
}

function migrate(raw: unknown): DesktopStateV1 {
  const candidate =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const threads = Array.isArray(candidate.threads)
    ? candidate.threads
        .map(normalizeThread)
        .filter((thread): thread is ThreadRecord => Boolean(thread))
    : [];
  const timelines: Record<string, ThreadTimeline> = {};
  if (
    candidate.timelines &&
    typeof candidate.timelines === "object" &&
    !Array.isArray(candidate.timelines)
  ) {
    for (const [threadId, timeline] of Object.entries(
      candidate.timelines as Record<string, unknown>,
    )) {
      if (!timeline || typeof timeline !== "object") continue;
      const value = timeline as Partial<ThreadTimeline>;
      const contextWindow = normalizeContextWindow(value.contextWindow);
      timelines[threadId] = {
        version: 1,
        threadId,
        items: Array.isArray(value.items)
          ? value.items
              .map(normalizeTimelineItem)
              .filter((item): item is TimelineItem => Boolean(item))
          : [],
        ...(contextWindow ? { contextWindow } : {}),
      };
    }
  }
  for (const thread of threads) {
    timelines[thread.id] ??= { version: 1, threadId: thread.id, items: [] };
  }
  const settings = normalizeSettings(candidate.settings);
  if (
    candidate.contextBudgetDefaultVersion !== 2 &&
    settings.maxContextTokens === 128_000
  ) {
    settings.maxContextTokens = DEFAULT_SETTINGS.maxContextTokens;
  }
  return {
    version: 1,
    contextBudgetDefaultVersion: 2,
    settings,
    threads,
    timelines,
  };
}

export class DesktopStore {
  readonly filePath: string;
  private state: DesktopStateV1 = copy(EMPTY_STATE);
  private initialized = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(readonly rootDir: string) {
    this.filePath = join(rootDir, "desktop-state.json");
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.rootDir, { recursive: true });
    try {
      this.state = migrate(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        const corruptPath = join(
          dirname(this.filePath),
          `desktop-state.corrupt-${Date.now()}.json`,
        );
        await rename(this.filePath, corruptPath).catch(() => undefined);
      }
      this.state = copy(EMPTY_STATE);
    }
    this.initialized = true;
    await this.persist();
  }

  getSettings(): AppSettings {
    this.assertInitialized();
    return copy(this.state.settings);
  }

  async updateSettings(patch: DeepPartial<AppSettings>): Promise<AppSettings> {
    this.assertInitialized();
    this.state.settings = mergeSettings(this.state.settings, patch);
    await this.persist();
    return this.getSettings();
  }

  listThreads(): ThreadRecord[] {
    this.assertInitialized();
    return copy(this.state.threads).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  getThread(threadId: string): ThreadRecord | undefined {
    this.assertInitialized();
    const thread = this.state.threads.find((entry) => entry.id === threadId);
    return thread ? copy(thread) : undefined;
  }

  async createThread(
    input: CreateThreadInput & { workspaceRoot: string },
  ): Promise<ThreadRecord> {
    this.assertInitialized();
    const now = new Date().toISOString();
    const provider = input.providerProfileId
      ? this.state.settings.providers.find(
          (entry) => entry.id === input.providerProfileId,
        )
      : this.state.settings.providers.find((entry) => entry.isDefault);
    const thread: ThreadRecord = {
      id: randomUUID(),
      sessionId: randomUUID(),
      title: input.title?.trim() || "New task",
      workspaceRoot: input.workspaceRoot,
      workspaceName: basename(input.workspaceRoot),
      providerProfileId: provider?.id ?? "",
      model: provider?.model ?? "",
      pinned: false,
      archived: false,
      unread: false,
      status: "idle",
      createdAt: now,
      updatedAt: now,
    };
    this.state.threads.push(thread);
    this.state.timelines[thread.id] = {
      version: 1,
      threadId: thread.id,
      items: [],
    };
    await this.persist();
    return copy(thread);
  }

  async updateThread(
    threadId: string,
    patch: UpdateThreadInput &
      Partial<Pick<ThreadRecord, "status" | "lastMessage" | "model">>,
  ): Promise<ThreadRecord> {
    this.assertInitialized();
    const thread = this.requireThread(threadId);
    if (typeof patch.title === "string" && patch.title.trim())
      thread.title = patch.title.trim();
    if (typeof patch.pinned === "boolean") thread.pinned = patch.pinned;
    if (typeof patch.archived === "boolean") thread.archived = patch.archived;
    if (typeof patch.providerProfileId === "string") {
      if (!patch.providerProfileId) {
        thread.providerProfileId = "";
        thread.model = "";
      } else {
        const provider = this.state.settings.providers.find(
          (entry) => entry.id === patch.providerProfileId,
        );
        if (!provider)
          throw new Error(
            `Unknown provider profile: ${patch.providerProfileId}`,
          );
        thread.providerProfileId = provider.id;
        thread.model = provider.model;
      }
    }
    if (patch.status) thread.status = patch.status;
    if (patch.model !== undefined) thread.model = patch.model;
    if (patch.lastMessage !== undefined) thread.lastMessage = patch.lastMessage;
    thread.updatedAt = new Date().toISOString();
    await this.persist();
    return copy(thread);
  }

  async deleteThread(threadId: string): Promise<void> {
    this.assertInitialized();
    const index = this.state.threads.findIndex(
      (entry) => entry.id === threadId,
    );
    if (index < 0) throw new Error(`Unknown thread: ${threadId}`);
    this.state.threads.splice(index, 1);
    delete this.state.timelines[threadId];
    await this.persist();
  }

  async markThreadUnread(
    threadId: string,
    completedAt: string,
  ): Promise<ThreadRecord> {
    this.assertInitialized();
    if (Number.isNaN(Date.parse(completedAt))) {
      throw new Error("Invalid unread completion timestamp");
    }
    const thread = this.requireThread(threadId);
    thread.unread = true;
    thread.unreadAt = completedAt;
    await this.persist();
    return copy(thread);
  }

  async markThreadRead(threadId: string): Promise<ThreadRecord> {
    this.assertInitialized();
    const thread = this.requireThread(threadId);
    if (!thread.unread && thread.unreadAt === undefined) return copy(thread);
    thread.unread = false;
    thread.unreadAt = undefined;
    await this.persist();
    return copy(thread);
  }

  async resetThreadContext(
    threadId: string,
  ): Promise<{ thread: ThreadRecord; timeline: ThreadTimeline }> {
    this.assertInitialized();
    const thread = this.requireThread(threadId);
    thread.sessionId = randomUUID();
    thread.status = "idle";
    thread.lastMessage = undefined;
    thread.unread = false;
    thread.unreadAt = undefined;
    thread.updatedAt = new Date().toISOString();
    const timeline: ThreadTimeline = {
      version: 1,
      threadId,
      items: [],
      contextWindow: {
        usedTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        source: "estimated-history",
        updatedAt: new Date().toISOString(),
      },
    };
    this.state.timelines[threadId] = timeline;
    await this.persist();
    return { thread: copy(thread), timeline: copy(timeline) };
  }

  getTimeline(threadId: string): ThreadTimeline {
    this.assertInitialized();
    this.requireThread(threadId);
    const timeline = this.state.timelines[threadId] ?? {
      version: 1 as const,
      threadId,
      items: [],
    };
    return copy(timeline);
  }

  async saveTimeline(timeline: ThreadTimeline): Promise<void> {
    this.assertInitialized();
    this.requireThread(timeline.threadId);
    this.state.timelines[timeline.threadId] = copy({ ...timeline, version: 1 });
    await this.persist();
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private requireThread(threadId: string): ThreadRecord {
    const thread = this.state.threads.find((entry) => entry.id === threadId);
    if (!thread) throw new Error(`Unknown thread: ${threadId}`);
    return thread;
  }

  private assertInitialized(): void {
    if (!this.initialized)
      throw new Error("DesktopStore.init() must be called first");
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2) + "\n";
    const operation = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, this.filePath);
      });
    // Keep the internal queue usable after a failed write while still exposing
    // this operation's failure to its caller.
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }
}
