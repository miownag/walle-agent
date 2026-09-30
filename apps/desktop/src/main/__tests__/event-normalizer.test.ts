import { describe, expect, it } from "vitest";
import type { AssistantTimelineItem } from "../../shared/contracts";
import { AgentEventNormalizer } from "../event-normalizer";

function assistant(): AssistantTimelineItem {
  return {
    id: "assistant-1",
    type: "assistant",
    runId: "desktop-run",
    status: "running",
    createdAt: new Date().toISOString(),
    steps: [],
    finalAnswer: "",
    draftAnswer: "",
    processDisclosure: "auto",
    processUserOverride: false,
  };
}

describe("AgentEventNormalizer", () => {
  it("publishes each model call's provider usage as a non-cumulative context snapshot", () => {
    const item = assistant();
    const normalizer = new AgentEventNormalizer(
      { threadId: "thread", sessionId: "session", runId: "desktop-run" },
      item,
    );
    normalizer.consume({ type: "model_call_start", turn: 0 });
    normalizer.consume({
      type: "llm_chunk",
      chunk: {
        type: "message_complete",
        message: { role: "assistant", content: "Inspecting" },
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      },
    });
    const first = normalizer.consume({
      type: "model_call_end",
      message: {
        role: "assistant",
        content: "Inspecting",
        toolCalls: [{ id: "call-1", name: "read_file", arguments: {} }],
      },
      usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
    });

    normalizer.consume({ type: "model_call_start", turn: 1 });
    normalizer.consume({
      type: "llm_chunk",
      chunk: {
        type: "message_complete",
        message: { role: "assistant", content: "Done" },
        usage: {
          promptTokens: 40,
          completionTokens: 10,
          totalTokens: 50,
          cacheReadTokens: 24,
          cacheWriteTokens: 4,
        },
      },
    });
    const second = normalizer.consume({
      type: "model_call_end",
      message: { role: "assistant", content: "Done" },
      usage: {
        promptTokens: 40,
        completionTokens: 10,
        totalTokens: 50,
        cacheReadTokens: 24,
        cacheWriteTokens: 4,
      },
    });

    expect(
      first.find((event) => event.type === "context.updated")?.payload,
    ).toMatchObject({
      usedTokens: 30,
      inputTokens: 20,
      outputTokens: 10,
      source: "provider",
    });
    expect(
      second.find((event) => event.type === "context.updated")?.payload,
    ).toMatchObject({
      usedTokens: 50,
      inputTokens: 40,
      outputTokens: 10,
      cacheReadTokens: 24,
      cacheWriteTokens: 4,
      source: "provider",
    });
    expect(item.usage?.totalTokens).toBe(80);
  });

  it("deduplicates thinking compatibility events and uses only the no-tool phase as final", () => {
    const item = assistant();
    const normalizer = new AgentEventNormalizer(
      { threadId: "thread", sessionId: "session", runId: "desktop-run" },
      item,
    );
    const events = [normalizer.started("fix it")];
    events.push(...normalizer.consume({ type: "model_call_start", turn: 0 }));
    events.push(
      ...normalizer.consume({
        type: "llm_chunk",
        chunk: { type: "thinking_delta", content: "inspect" },
      }),
    );
    events.push(
      ...normalizer.consume({ type: "thinking_delta", content: "inspect" }),
    );
    events.push(
      ...normalizer.consume({ type: "text_delta", content: "I will inspect." }),
    );
    events.push(
      ...normalizer.consume({
        type: "model_call_end",
        message: {
          role: "assistant",
          content: "I will inspect.",
          toolCalls: [
            { id: "call-1", name: "read_file", arguments: { path: "a.ts" } },
          ],
        },
      }),
    );
    events.push(
      ...normalizer.consume({
        type: "tool_call_start",
        call: { id: "call-1", name: "read_file", arguments: { path: "a.ts" } },
      }),
    );
    events.push(
      ...normalizer.consume({
        type: "tool_call_end",
        record: {
          id: "call-1",
          name: "read_file",
          input: {},
          output: "source",
          status: "success",
          durationMs: 3,
        },
      }),
    );
    events.push(...normalizer.consume({ type: "model_call_start", turn: 1 }));
    events.push(
      ...normalizer.consume({ type: "text_delta", content: "Final fix." }),
    );
    events.push(
      ...normalizer.consume({
        type: "model_call_end",
        message: { role: "assistant", content: "Final fix." },
      }),
    );
    events.push(
      ...normalizer.consume({ type: "run_end", status: "completed" }),
    );

    expect(
      events.filter(
        (event) =>
          event.type === "reasoning.delta" &&
          (event.payload as { delta?: string }).delta === "inspect",
      ),
    ).toHaveLength(1);
    expect(
      events.some(
        (event) =>
          event.type === "answer.delta" &&
          (event.payload as { reset?: boolean }).reset,
      ),
    ).toBe(true);
    expect(
      events.filter((event) => event.type === "assistant.completed"),
    ).toHaveLength(1);
    expect(item.finalAnswer).toBe("Final fix.");
    expect(item.finalAnswer).not.toContain("I will inspect");
    expect(item.status).toBe("completed");
    expect(item.processDisclosure).toBe("collapsed");
  });

  it("keeps failed/no-final runs expanded and preserves a user disclosure override", () => {
    const failed = assistant();
    const failedNormalizer = new AgentEventNormalizer(
      { threadId: "thread", sessionId: "session", runId: "desktop-run" },
      failed,
    );
    failedNormalizer.consume({ type: "model_call_start", turn: 0 });
    const failedEvents = failedNormalizer.consume({
      type: "run_end",
      status: "completed",
    });
    expect(failed.status).toBe("error");
    expect(failed.processDisclosure).toBe("expanded");
    expect(failedEvents.at(-1)?.type).toBe("run.failed");

    const overridden = assistant();
    overridden.processDisclosure = "expanded";
    overridden.processUserOverride = true;
    const normalizer = new AgentEventNormalizer(
      { threadId: "thread", sessionId: "session", runId: "desktop-run" },
      overridden,
    );
    normalizer.consume({ type: "model_call_start", turn: 0 });
    normalizer.consume({ type: "text_delta", content: "Done" });
    normalizer.consume({
      type: "model_call_end",
      message: { role: "assistant", content: "Done" },
    });
    normalizer.consume({ type: "run_end", status: "completed" });
    expect(overridden.processDisclosure).toBe("expanded");
  });

  it("keeps a completed run expanded when a tool was denied", () => {
    const item = assistant();
    const normalizer = new AgentEventNormalizer(
      { threadId: "thread", sessionId: "session", runId: "desktop-run" },
      item,
    );
    normalizer.consume({ type: "model_call_start", turn: 0 });
    normalizer.consume({
      type: "tool_call_start",
      call: { id: "call-1", name: "shell", arguments: {} },
    });
    normalizer.consume({
      type: "tool_call_end",
      record: {
        id: "call-1",
        name: "shell",
        input: {},
        output: {},
        status: "denied",
      },
    });
    normalizer.consume({
      type: "model_call_end",
      message: { role: "assistant", content: "Done" },
    });
    normalizer.consume({ type: "run_end", status: "completed" });
    expect(item.status).toBe("completed");
    expect(item.processDisclosure).toBe("expanded");
  });

  it.each([
    {
      recordStatus: "error" as const,
      stepStatus: "error" as const,
      output: {
        stdout: "partial output\n",
        stderr: "command failed\n",
        exitCode: 2,
        durationMs: 4,
        timedOut: false,
      },
      error: "Shell command exited with code 2",
    },
    {
      recordStatus: "timeout" as const,
      stepStatus: "cancelled" as const,
      output: {
        stdout: "output before timeout\n",
        stderr: "",
        exitCode: 137,
        durationMs: 5,
        timedOut: true,
      },
      error: "Shell command timed out",
    },
  ])(
    "normalizes a resolved shell $recordStatus as $stepStatus and keeps the process expanded",
    ({ recordStatus, stepStatus, output, error }) => {
      const item = assistant();
      const normalizer = new AgentEventNormalizer(
        {
          threadId: "thread",
          sessionId: "session",
          runId: "desktop-run",
        },
        item,
      );
      normalizer.consume({ type: "model_call_start", turn: 0 });
      normalizer.consume({
        type: "tool_call_start",
        call: { id: "shell-call", name: "shell", arguments: {} },
      });
      const events = normalizer.consume({
        type: "tool_call_end",
        record: {
          id: "shell-call",
          name: "shell",
          input: {},
          output,
          status: recordStatus,
          durationMs: output.durationMs,
          error,
        },
      });
      normalizer.consume({
        type: "model_call_end",
        message: { role: "assistant", content: "Done" },
      });
      normalizer.consume({ type: "run_end", status: "completed" });

      const step = item.steps.find(
        (entry) => entry.toolCallId === "shell-call",
      );
      expect(step).toMatchObject({
        status: stepStatus,
        output,
        content: error,
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "tool.completed",
          payload: expect.objectContaining({
            step: expect.objectContaining({ status: stepStatus, output }),
          }),
        }),
      );
      expect(item.status).toBe("completed");
      expect(item.processDisclosure).toBe("expanded");
    },
  );
});
