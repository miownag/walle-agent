import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentManager } from "../agent-manager";
import { DesktopStore } from "../desktop-store";
import type { ProviderService } from "../provider-service";

describe("AgentManager context commands", () => {
  let directory: string;
  let runtimeRoot: string;
  let store: DesktopStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "walle-agent-context-"));
    runtimeRoot = join(directory, "runtime");
    store = new DesktopStore(join(directory, "store"));
    await store.init();
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("clears the visible timeline, rotates the session, and removes only the previous session log", async () => {
    const thread = await store.createThread({
      workspaceRoot: directory,
      title: "Clear context",
    });
    const timeline = store.getTimeline(thread.id);
    timeline.items.push({
      id: "user-old",
      type: "user",
      content: "old context",
      createdAt: new Date().toISOString(),
    });
    await store.saveTimeline(timeline);
    const previousSession = join(
      runtimeRoot,
      thread.id,
      "sessions",
      thread.sessionId,
    );
    await mkdir(previousSession, { recursive: true });
    await writeFile(join(previousSession, "messages.jsonl"), "old\n");

    const dispose = vi.fn().mockResolvedValue(undefined);
    const manager = new AgentManager(
      store,
      {} as ProviderService,
      runtimeRoot,
      () => undefined,
    );
    const handles = (
      manager as unknown as {
        handles: Map<string, unknown>;
      }
    ).handles;
    handles.set(thread.id, {
      signature: "test",
      agent: { dispose, isRunning: false },
      stale: false,
    });

    const result = await manager.clearContext(thread.id);

    expect(dispose).toHaveBeenCalledOnce();
    expect(result.thread.sessionId).not.toBe(thread.sessionId);
    expect(result.timeline.items).toEqual([]);
    expect(store.getTimeline(thread.id).items).toEqual([]);
    await expect(access(previousSession)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("delegates explicit compaction to the idle thread Agent", async () => {
    const thread = await store.createThread({
      workspaceRoot: directory,
      title: "Compact context",
    });
    const compact = vi.fn().mockResolvedValue({
      summary: "summary",
      beforeMessages: 12,
      afterMessages: 5,
      beforeTokens: 400,
      afterTokens: 120,
      droppedMessages: 7,
    });
    const manager = new AgentManager(
      store,
      {} as ProviderService,
      runtimeRoot,
      () => undefined,
    );
    Object.defineProperty(manager, "ensureHandle", {
      configurable: true,
      value: vi.fn().mockResolvedValue({
        signature: "test",
        agent: { compact, isRunning: false },
        stale: false,
      }),
    });

    await expect(manager.compactContext(thread.id)).resolves.toMatchObject({
      droppedMessages: 7,
      afterMessages: 5,
    });
    expect(compact).toHaveBeenCalledOnce();
    expect(store.getTimeline(thread.id).contextWindow).toMatchObject({
      usedTokens: 120,
      inputTokens: 120,
      outputTokens: 0,
      source: "estimated-history",
      updatedAt: expect.any(String),
    });
  });
});
