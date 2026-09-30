import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LLMProvider } from "@walle-agent/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopStore } from "../desktop-store";
import type { ProviderService } from "../provider-service";
import {
  sanitizeGeneratedTitle,
  ThreadTitleService,
} from "../thread-title-service";

const roots: string[] = [];

async function makeStore(): Promise<{
  store: DesktopStore;
  threadId: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "walle-thread-title-"));
  roots.push(root);
  const store = new DesktopStore(root);
  await store.init();
  const thread = await store.createThread({
    workspaceRoot: root,
    title: "New task",
  });
  const timeline = store.getTimeline(thread.id);
  timeline.items.push({
    id: "first-user-message",
    type: "user",
    content: "修复侧边栏搜索导致的布局跳动",
    createdAt: new Date().toISOString(),
  });
  await store.saveTimeline(timeline);
  return { store, threadId: thread.id };
}

function providersWith(model: LLMProvider): ProviderService {
  return {
    createModel: vi.fn((profileId?: string) => ({
      profile: { id: profileId },
      model,
    })),
  } as unknown as ProviderService;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ThreadTitleService", () => {
  it("uses one stateless provider chat and persists a sanitized short title", async () => {
    const { store, threadId } = await makeStore();
    const chat = vi.fn(async () => ({
      message: {
        role: "assistant" as const,
        content: '标题："修复侧边栏搜索跳动。"',
      },
    }));
    const providers = providersWith({
      name: "mock",
      chat,
      async *stream() {},
    });
    const generated = vi.fn();
    const titles = new ThreadTitleService(store, providers, generated);

    const updated = await titles.requestTitle(
      threadId,
      "修复侧边栏搜索导致的布局跳动",
    );

    expect(providers.createModel).toHaveBeenCalledWith("");
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledWith({
      messages: [
        expect.objectContaining({ role: "system" }),
        {
          role: "user",
          content: "修复侧边栏搜索导致的布局跳动",
        },
      ],
      maxTokens: 512,
      signal: expect.any(AbortSignal),
    });
    expect(updated?.title).toBe("修复侧边栏搜索跳动");
    expect(store.getThread(threadId)?.title).toBe("修复侧边栏搜索跳动");
    expect(generated).toHaveBeenCalledWith(
      expect.objectContaining({ id: threadId, title: "修复侧边栏搜索跳动" }),
    );
  });

  it("deduplicates concurrent requests and never overwrites a manual rename", async () => {
    const { store, threadId } = await makeStore();
    let resolveChat!: (value: {
      message: { role: "assistant"; content: string };
    }) => void;
    const chat = vi.fn(
      () =>
        new Promise<{ message: { role: "assistant"; content: string } }>(
          (resolve) => {
            resolveChat = resolve;
          },
        ),
    );
    const generated = vi.fn();
    const titles = new ThreadTitleService(
      store,
      providersWith({ name: "mock", chat, async *stream() {} }),
      generated,
    );

    const first = titles.requestTitle(threadId, "修复侧边栏搜索导致的布局跳动");
    const duplicate = titles.requestTitle(
      threadId,
      "修复侧边栏搜索导致的布局跳动",
    );
    expect(first).toBe(duplicate);
    expect(chat).toHaveBeenCalledTimes(1);

    await store.updateThread(threadId, { title: "我手动设置的名称" });
    resolveChat({
      message: { role: "assistant", content: "自动生成的名称" },
    });

    await expect(first).resolves.toBeNull();
    expect(store.getThread(threadId)?.title).toBe("我手动设置的名称");
    expect(generated).not.toHaveBeenCalled();
  });

  it("swallows provider failures and attempts at most once per context", async () => {
    const { store, threadId } = await makeStore();
    const chat = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const titles = new ThreadTitleService(
      store,
      providersWith({ name: "mock", chat, async *stream() {} }),
    );

    await expect(
      titles.requestTitle(threadId, "修复侧边栏搜索导致的布局跳动"),
    ).resolves.toBeNull();
    await expect(
      titles.requestTitle(threadId, "修复侧边栏搜索导致的布局跳动"),
    ).resolves.toBeNull();

    expect(chat).toHaveBeenCalledTimes(1);
    expect(store.getThread(threadId)?.title).toBe("New task");
  });

  it("aborts pending work on reset and permits the fresh context to retry", async () => {
    const { store, threadId } = await makeStore();
    const signals: AbortSignal[] = [];
    const chat = vi.fn(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          if (!signal) return;
          signals.push(signal);
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const titles = new ThreadTitleService(
      store,
      providersWith({
        name: "mock",
        chat: chat as LLMProvider["chat"],
        async *stream() {},
      }),
    );

    const pending = titles.requestTitle(
      threadId,
      "修复侧边栏搜索导致的布局跳动",
    );
    titles.reset(threadId);

    await expect(pending).resolves.toBeNull();
    expect(signals[0]?.aborted).toBe(true);
    expect(store.getThread(threadId)?.title).toBe("New task");
  });

  it("refuses later-turn requests even when the title is still default", async () => {
    const { store, threadId } = await makeStore();
    const timeline = store.getTimeline(threadId);
    timeline.items.push({
      id: "second-user-message",
      type: "user",
      content: "再补一个需求",
      createdAt: new Date().toISOString(),
    });
    await store.saveTimeline(timeline);
    const chat = vi.fn();
    const titles = new ThreadTitleService(
      store,
      providersWith({ name: "mock", chat, async *stream() {} }),
    );

    await expect(
      titles.requestTitle(threadId, "再补一个需求"),
    ).resolves.toBeNull();
    expect(chat).not.toHaveBeenCalled();
  });
});

describe("sanitizeGeneratedTitle", () => {
  it("normalizes labels, Markdown, quotes, punctuation, and excessive length", () => {
    expect(sanitizeGeneratedTitle('## Title: "Fix sidebar search."')).toBe(
      "Fix sidebar search",
    );
    expect(sanitizeGeneratedTitle("```\n标题\n```")).toBe("标题");
    expect(sanitizeGeneratedTitle("安全\u0000标题\u202e")).toBe("安全标题");
    expect(sanitizeGeneratedTitle("x".repeat(60))).toHaveLength(48);
  });
});
