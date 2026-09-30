import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Attachment } from "@walle-agent/core";
import type {
  AgentEventEnvelope,
  AssistantTimelineItem,
  ThreadRecord,
  ThreadTimeline,
} from "../../shared/contracts";
import { AgentManager } from "../agent-manager";
import { DesktopStore } from "../desktop-store";
import { AgentEventNormalizer } from "../event-normalizer";
import type { ProviderService } from "../provider-service";

interface PrivateRun {
  executeRun(
    thread: ThreadRecord,
    handle: unknown,
    active: unknown,
    prompt: string,
    attachments?: Attachment[],
  ): Promise<void>;
}

function activeRun(thread: ThreadRecord, runId: string) {
  const assistant: AssistantTimelineItem = {
    id: `assistant-${runId}`,
    type: "assistant",
    runId,
    status: "running",
    createdAt: "2026-08-10T08:00:00.000Z",
    steps: [],
    finalAnswer: "",
    draftAnswer: "",
    processDisclosure: "auto",
    processUserOverride: false,
  };
  const timeline: ThreadTimeline = {
    version: 1,
    threadId: thread.id,
    items: [assistant],
  };
  return {
    runId,
    normalizer: new AgentEventNormalizer(
      { threadId: thread.id, sessionId: thread.sessionId, runId },
      assistant,
    ),
    timeline,
    done: Promise.resolve(),
  };
}

describe("AgentManager completion lifecycle", () => {
  let directory: string;
  let store: DesktopStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "walle-agent-completion-"));
    store = new DesktopStore(directory);
    await store.init();
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("publishes completion only after a successful run is persisted and idle", async () => {
    const thread = await store.createThread({
      workspaceRoot: directory,
      title: "Background task",
    });
    await store.updateThread(thread.id, { status: "running" });
    const active = activeRun(thread, "run-success");
    const events: AgentEventEnvelope[] = [];
    const observedStatuses: string[] = [];
    const completed = vi.fn(async () => {
      observedStatuses.push(store.getThread(thread.id)?.status ?? "missing");
    });
    const manager = new AgentManager(
      store,
      {} as ProviderService,
      join(directory, "runtime"),
      (event) => events.push(event),
      completed,
    );
    const agent = {
      async *run() {
        yield { type: "model_call_start", turn: 0 };
        yield { type: "text_delta", content: "Done" };
        yield {
          type: "model_call_end",
          message: { role: "assistant", content: "Done" },
          usage: {
            promptTokens: 90,
            completionTokens: 10,
            totalTokens: 100,
          },
        };
        yield { type: "run_end", status: "completed" };
      },
    };
    const handle = {
      signature: "test",
      agent,
      active,
      lastNormalizer: active.normalizer,
      stale: false,
    };

    await (manager as unknown as PrivateRun).executeRun(
      thread,
      handle,
      active,
      "work",
    );

    expect(events.at(-1)?.type).toBe("run.completed");
    expect(completed).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: thread.id,
        runId: "run-success",
        completedAt: expect.any(String),
      }),
    );
    expect(observedStatuses).toEqual(["idle"]);
    expect(store.getTimeline(thread.id).items[0]).toMatchObject({
      type: "assistant",
      status: "completed",
      finalAnswer: "Done",
    });
    expect(store.getTimeline(thread.id).contextWindow).toMatchObject({
      usedTokens: 100,
      inputTokens: 90,
      outputTokens: 10,
      source: "provider",
    });
  });

  it("does not publish completion for a failed run", async () => {
    const thread = await store.createThread({
      workspaceRoot: directory,
      title: "Failed task",
    });
    const active = activeRun(thread, "run-failed");
    const completed = vi.fn();
    const manager = new AgentManager(
      store,
      {} as ProviderService,
      join(directory, "runtime"),
      () => undefined,
      completed,
    );
    const handle = {
      signature: "test",
      agent: {
        async *run() {
          yield { type: "run_end", status: "error", error: "boom" };
        },
      },
      active,
      lastNormalizer: active.normalizer,
      stale: false,
    };

    await (manager as unknown as PrivateRun).executeRun(
      thread,
      handle,
      active,
      "work",
    );

    expect(completed).not.toHaveBeenCalled();
    expect(store.getThread(thread.id)?.status).toBe("error");
  });

  it("passes transient image attachments to the core run input", async () => {
    const thread = await store.createThread({
      workspaceRoot: directory,
      title: "Image task",
    });
    const active = activeRun(thread, "run-image");
    const runInputs: unknown[] = [];
    const manager = new AgentManager(
      store,
      {} as ProviderService,
      join(directory, "runtime"),
      () => undefined,
    );
    const handle = {
      signature: "test",
      agent: {
        async *run(input: unknown) {
          runInputs.push(input);
          yield { type: "run_end", status: "completed" };
        },
      },
      active,
      lastNormalizer: active.normalizer,
      stale: false,
    };
    const attachment: Attachment = {
      type: "image",
      name: "pasted.png",
      mimeType: "image/png",
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    };

    await (manager as unknown as PrivateRun).executeRun(
      thread,
      handle,
      active,
      "inspect the image",
      [attachment],
    );

    expect(runInputs).toEqual([
      expect.objectContaining({
        content: "inspect the image",
        attachments: [attachment],
        sessionId: thread.sessionId,
      }),
    ]);
  });

  it("persists a readable display prompt while sending the expanded model prompt", async () => {
    const thread = await store.createThread({
      workspaceRoot: directory,
      title: "New task",
    });
    const events: AgentEventEnvelope[] = [];
    const runInputs: unknown[] = [];
    let releaseRun!: () => void;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const titleChat = vi.fn(async () => ({
      message: {
        role: "assistant" as const,
        content: "Inspect referenced agent file",
      },
    }));
    const providers = {
      createModel: vi.fn(() => ({
        profile: {},
        model: {
          name: "title-test",
          chat: titleChat,
          async *stream() {},
        },
      })),
    } as unknown as ProviderService;
    const titleGenerated = vi.fn();
    const manager = new AgentManager(
      store,
      providers,
      join(directory, "runtime"),
      (event) => events.push(event),
      undefined,
      titleGenerated,
    );
    const handle = {
      signature: "test",
      agent: {
        isRunning: false,
        async *run(input: unknown) {
          runInputs.push(input);
          await runGate;
          yield { type: "run_end", status: "completed" };
        },
      },
      active: undefined as ReturnType<typeof activeRun> | undefined,
      lastNormalizer: undefined,
      stale: false,
    };
    (
      manager as unknown as {
        ensureHandle(): Promise<typeof handle>;
      }
    ).ensureHandle = async () => handle;

    await manager.startRun(
      thread.id,
      "Please inspect /workspace/src/agent.ts",
      [],
      "Please inspect @[src/agent.ts]",
      [
        { type: "text", text: "Please inspect " },
        {
          type: "file",
          name: "agent.ts",
          relativePath: "src/agent.ts",
        },
      ],
    );

    expect(store.getTimeline(thread.id).items[0]).toMatchObject({
      type: "user",
      content: "Please inspect @[src/agent.ts]",
      parts: [
        { type: "text", text: "Please inspect " },
        {
          type: "file",
          name: "agent.ts",
          relativePath: "src/agent.ts",
        },
      ],
    });
    await vi.waitFor(() =>
      expect(store.getThread(thread.id)).toMatchObject({
        title: "Inspect referenced agent file",
      }),
    );
    expect(store.getThread(thread.id)).toMatchObject({
      lastMessage: "Please inspect @[src/agent.ts]",
    });
    expect(titleChat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          {
            role: "user",
            content: "Please inspect @[src/agent.ts]",
          },
        ]),
      }),
    );
    await vi.waitFor(() =>
      expect(titleGenerated).toHaveBeenCalledWith(
        expect.objectContaining({
          id: thread.id,
          title: "Inspect referenced agent file",
        }),
      ),
    );
    expect(events[0]).toMatchObject({
      type: "run.started",
      payload: { prompt: "Please inspect @[src/agent.ts]" },
    });
    expect(runInputs).toEqual([
      expect.objectContaining({
        content: "Please inspect /workspace/src/agent.ts",
      }),
    ]);

    const done = handle.active?.done;
    releaseRun();
    await done;
  });
});
