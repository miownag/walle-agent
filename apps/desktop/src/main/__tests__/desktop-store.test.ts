import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DesktopStore } from "../desktop-store";

describe("DesktopStore", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "walle-desktop-store-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("persists per-thread model selection and preserves it when the provider default changes", async () => {
    const store = new DesktopStore(directory);
    await store.init();
    const profile = {
      id: "multi",
      name: "Gateway",
      kind: "anthropic" as const,
      model: "first",
      models: [
        { value: "first" },
        { label: "Second", value: "second", description: "Fast" },
      ],
      hasApiKey: true,
      isDefault: true,
    };
    await store.updateSettings({ providers: [profile] });
    const first = await store.createThread({
      workspaceRoot: directory,
      model: "second",
    });
    const other = await store.createThread({ workspaceRoot: directory });
    expect(first.model).toBe("second");
    expect(other.model).toBe("first");
    await store.updateThread(first.id, { model: "first" });
    await store.updateSettings({
      providers: [{ ...profile, model: "second" }],
    });
    expect(store.getThread(first.id)?.model).toBe("first");
    await expect(
      store.updateThread(first.id, {
        model: "missing",
        title: "Must not persist",
      }),
    ).rejects.toThrow(/Unknown model/);
    expect(store.getThread(first.id)?.title).toBe(first.title);
    const restored = new DesktopStore(directory);
    await restored.init();
    expect(restored.getThread(first.id)?.model).toBe("first");
    expect(restored.getSettings().providers[0].models?.[0].label).toBe("first");
  });

  it("creates defaults and atomically round-trips threads and timelines", async () => {
    const store = new DesktopStore(directory);
    await store.init();
    const thread = await store.createThread({
      workspaceRoot: directory,
      title: "Test task",
    });
    const timeline = store.getTimeline(thread.id);
    timeline.items.push({
      id: "user-1",
      type: "user",
      content: "Review @[src/agent.ts]",
      parts: [
        { type: "text", text: "Review " },
        {
          type: "file",
          name: "agent.ts",
          relativePath: "src/agent.ts",
        },
      ],
      createdAt: new Date().toISOString(),
    });
    timeline.contextWindow = {
      usedTokens: 240,
      inputTokens: 200,
      outputTokens: 40,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
      maxTokens: 16_384,
      source: "provider",
      updatedAt: "2026-08-20T09:30:00.000Z",
    };
    await store.saveTimeline(timeline);
    await store.updateThread(thread.id, { status: "running", pinned: true });
    const completedAt = "2026-08-10T08:09:10.000Z";
    await store.markThreadUnread(thread.id, completedAt);
    await store.flush();

    const persisted = JSON.parse(await readFile(store.filePath, "utf8"));
    expect(persisted.version).toBe(1);
    expect(persisted.timelines[thread.id].items).toHaveLength(1);
    expect(
      (await readdir(directory)).some((name) => name.endsWith(".tmp")),
    ).toBe(false);

    const reopened = new DesktopStore(directory);
    await reopened.init();
    expect(reopened.getThread(thread.id)?.status).toBe("idle");
    expect(reopened.getThread(thread.id)?.pinned).toBe(true);
    expect(reopened.getThread(thread.id)).toMatchObject({
      unread: true,
      unreadAt: completedAt,
    });
    expect(reopened.getTimeline(thread.id).items[0]).toMatchObject({
      type: "user",
      content: "Review @[src/agent.ts]",
      parts: [
        { type: "text", text: "Review " },
        {
          type: "file",
          name: "agent.ts",
          relativePath: "src/agent.ts",
        },
      ],
    });
    expect(reopened.getTimeline(thread.id).contextWindow).toEqual({
      usedTokens: 240,
      inputTokens: 200,
      outputTokens: 40,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
      maxTokens: 16_384,
      source: "provider",
      updatedAt: "2026-08-20T09:30:00.000Z",
    });

    const markedRead = await reopened.markThreadRead(thread.id);
    expect(markedRead.unread).toBe(false);
    expect(markedRead.unreadAt).toBeUndefined();
    const reopenedAgain = new DesktopStore(directory);
    await reopenedAgain.init();
    expect(reopenedAgain.getThread(thread.id)).toMatchObject({ unread: false });
    expect(reopenedAgain.getThread(thread.id)?.unreadAt).toBeUndefined();
  });

  it("upgrades the former default context budget once while preserving later edits", async () => {
    await writeFile(
      join(directory, "desktop-state.json"),
      JSON.stringify({
        version: 1,
        settings: { maxContextTokens: 128_000 },
        threads: [],
        timelines: {},
      }),
    );
    const store = new DesktopStore(directory);
    await store.init();
    expect(store.getSettings().maxContextTokens).toBe(256_000);
    await store.updateSettings({ maxContextTokens: 128_000 });
    const reopened = new DesktopStore(directory);
    await reopened.init();
    expect(reopened.getSettings().maxContextTokens).toBe(128_000);
  });

  it("migrates an unversioned legacy state and fills missing settings", async () => {
    await writeFile(
      join(directory, "desktop-state.json"),
      JSON.stringify({
        settings: { appearance: { theme: "dark" } },
        threads: [
          {
            id: "thread-1",
            sessionId: "session-1",
            title: "Legacy",
            workspaceRoot: directory,
            status: "approval",
          },
        ],
        timelines: {
          "thread-1": {
            items: [
              {
                id: "assistant-1",
                type: "assistant",
                runId: "run-1",
                status: "running",
                createdAt: new Date().toISOString(),
                steps: [
                  {
                    id: "step-1",
                    type: "tool",
                    title: "shell",
                    status: "running",
                  },
                ],
                finalAnswer: "",
                draftAnswer: "partial",
                processDisclosure: "auto",
                processUserOverride: false,
              },
            ],
          },
        },
      }),
    );

    const store = new DesktopStore(directory);
    await store.init();
    expect(store.getSettings().appearance.theme).toBe("dark");
    expect(store.getSettings().sandbox.kind).toBe("local");
    expect(store.getThread("thread-1")).toMatchObject({
      status: "idle",
      workspaceName: expect.any(String),
      unread: false,
    });
    expect(store.getTimeline("thread-1").version).toBe(1);
    expect(store.getTimeline("thread-1").items[0]).toMatchObject({
      type: "assistant",
      status: "cancelled",
      processDisclosure: "expanded",
      draftAnswer: "",
      steps: [{ status: "cancelled" }],
    });
  });

  it("resets a task onto a fresh session and clears its visible context", async () => {
    const store = new DesktopStore(directory);
    await store.init();
    const thread = await store.createThread({
      workspaceRoot: directory,
      title: "Reset me",
    });
    const originalSessionId = thread.sessionId;
    const timeline = store.getTimeline(thread.id);
    timeline.items.push({
      id: "user-before-reset",
      type: "user",
      content: "old context",
      createdAt: new Date().toISOString(),
    });
    await store.saveTimeline(timeline);
    await store.updateThread(thread.id, {
      status: "error",
      lastMessage: "old context",
    });
    await store.markThreadUnread(thread.id, "2026-08-10T08:09:10.000Z");

    const reset = await store.resetThreadContext(thread.id);

    expect(reset.thread.sessionId).not.toBe(originalSessionId);
    expect(reset.thread).toMatchObject({
      status: "idle",
      unread: false,
    });
    expect(reset.thread.lastMessage).toBeUndefined();
    expect(reset.thread.unreadAt).toBeUndefined();
    expect(reset.timeline).toMatchObject({
      version: 1,
      threadId: thread.id,
      items: [],
      contextWindow: {
        usedTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        source: "estimated-history",
      },
    });

    const reopened = new DesktopStore(directory);
    await reopened.init();
    expect(reopened.getThread(thread.id)?.sessionId).toBe(
      reset.thread.sessionId,
    );
    expect(reopened.getTimeline(thread.id).items).toEqual([]);
    expect(reopened.getTimeline(thread.id).contextWindow?.usedTokens).toBe(0);
  });

  it("continues accepting writes after a transient persistence failure", async () => {
    const store = new DesktopStore(directory);
    await store.init();
    await rm(directory, { recursive: true, force: true });
    await expect(
      store.updateSettings({ appearance: { theme: "dark" } }),
    ).rejects.toThrow();

    await mkdir(directory, { recursive: true });
    await expect(
      store.updateSettings({ appearance: { theme: "light" } }),
    ).resolves.toBeDefined();
    expect(
      JSON.parse(await readFile(store.filePath, "utf8")).settings.appearance
        .theme,
    ).toBe("light");
  });
});
