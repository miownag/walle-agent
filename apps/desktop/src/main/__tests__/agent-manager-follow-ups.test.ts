import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type {
  LLMProvider,
  LLMChatRequest,
  LLMStreamChunk,
  ModelMessage,
} from "@walle-agent/core";
import { DesktopStore } from "../desktop-store";
import { AgentManager } from "../agent-manager";
import type { ProviderService } from "../provider-service";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "walle-follow-ups-"));
  const store = new DesktopStore(join(root, "store"));
  await store.init();
  await store.updateSettings({
    permissions: { mode: "auto" },
    capabilities: {
      memory: false,
      evolution: false,
      skills: false,
      trace: false,
      team: false,
      rag: false,
      mcp: false,
    },
  });
  const thread = await store.createThread({
    workspaceRoot: root,
    title: "Test",
  });
  const calls: ModelMessage[][] = [];
  const releases: Array<() => void> = [];
  const model: LLMProvider = {
    name: "controlled",
    chat: async () => {
      throw new Error("Unexpected title call");
    },
    async *stream(request: LLMChatRequest): AsyncIterable<LLMStreamChunk> {
      calls.push(structuredClone(request.messages));
      await new Promise<void>((resolve) => {
        releases.push(resolve);
        request.signal?.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
      yield {
        type: "message_complete",
        message: { role: "assistant", content: "Done" },
      };
    },
  };
  const manager = new AgentManager(
    store,
    {
      createModel: () => ({ model, profile: { name: "test", model: "test" } }),
    } as unknown as ProviderService,
    join(root, "runtime"),
    () => undefined,
  );
  return {
    root,
    store,
    thread,
    calls,
    releases,
    manager,
    cleanup: async () => {
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it("drains queued follow-ups in order and preserves them on disk", async () => {
  const f = await fixture();
  try {
    await f.manager.submitMessage(f.thread.id, "First");
    await vi.waitFor(() => expect(f.releases).toHaveLength(1));
    expect(await f.manager.submitMessage(f.thread.id, "Second")).toMatchObject({
      queued: true,
    });
    await f.manager.submitMessage(f.thread.id, "Third");
    expect(f.calls).toHaveLength(1);
    const reopened = new DesktopStore(join(f.root, "store"));
    await reopened.init();
    expect(
      reopened
        .getTimeline(f.thread.id)
        .pendingMessages?.map((item) => item.prompt),
    ).toEqual(["Second", "Third"]);
    f.releases[0]();
    await vi.waitFor(() => expect(f.releases).toHaveLength(2));
    expect(f.calls[1].at(-1)?.content).toBe("Second");
    f.releases[1]();
    await vi.waitFor(() => expect(f.releases).toHaveLength(3));
    expect(f.calls[2].at(-1)?.content).toBe("Third");
    f.releases[2]();
    await vi.waitFor(() =>
      expect(f.store.getThread(f.thread.id)?.status).toBe("idle"),
    );
    expect(f.store.getTimeline(f.thread.id).pendingMessages).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

it("steers the active run and persists the guidance for the following run", async () => {
  const f = await fixture();
  try {
    const first = await f.manager.submitMessage(f.thread.id, "Original");
    await vi.waitFor(() => expect(f.releases).toHaveLength(1));
    expect(
      await f.manager.submitMessage(
        f.thread.id,
        "Change direction",
        [],
        "Change direction",
        undefined,
        "steer",
      ),
    ).toMatchObject({ runId: first.runId, steered: true });
    f.releases[0]();
    await vi.waitFor(() => expect(f.releases).toHaveLength(2));
    expect(f.calls[1].at(-1)?.content).toBe("Change direction");
    f.releases[1]();
    await vi.waitFor(() =>
      expect(f.store.getThread(f.thread.id)?.status).toBe("idle"),
    );
    expect(f.store.getTimeline(f.thread.id).pendingMessages).toEqual([]);
    await f.manager.submitMessage(f.thread.id, "Next task");
    await vi.waitFor(() => expect(f.releases).toHaveLength(3));
    expect(
      f.calls[2].some(
        (message) =>
          message.role === "user" && message.content === "Change direction",
      ),
    ).toBe(true);
  } finally {
    await f.cleanup();
  }
});

it("pauses queued messages on cancellation and allows removal", async () => {
  const f = await fixture();
  try {
    await f.manager.submitMessage(f.thread.id, "Original");
    await vi.waitFor(() => expect(f.releases).toHaveLength(1));
    await f.manager.submitMessage(f.thread.id, "Pending");
    await f.manager.cancelRun(f.thread.id);
    await vi.waitFor(() =>
      expect(f.store.getThread(f.thread.id)?.status).toBe("idle"),
    );
    expect(f.calls).toHaveLength(1);
    const pending = f.store.getTimeline(f.thread.id).pendingMessages![0];
    await f.manager.updatePendingMessage(f.thread.id, pending.id, "remove");
    expect(f.store.getTimeline(f.thread.id).pendingMessages).toEqual([]);
  } finally {
    await f.cleanup();
  }
});
