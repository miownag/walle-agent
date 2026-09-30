import { describe, expect, it } from "vitest";

import type { AgentEventEnvelope } from "@shared/contracts";
import {
  agentStreamReducer,
  initialStreamState,
  processIsOpen,
} from "./agent-stream";

function event(
  sequence: number,
  type: AgentEventEnvelope["type"],
  payload: unknown,
  runId = "run-1",
): AgentEventEnvelope {
  return {
    version: 1,
    sequence,
    timestamp: new Date(1_700_000_000_000 + sequence).toISOString(),
    threadId: "thread-1",
    sessionId: "session-1",
    runId,
    type,
    payload,
  };
}

describe("agentStreamReducer", () => {
  it("streams provisional text, resets it, and commits only the final answer", () => {
    let state = agentStreamReducer(initialStreamState, {
      type: "event.received",
      event: event(1, "run.started", { prompt: "Build it" }),
    });
    state = agentStreamReducer(state, {
      type: "event.received",
      event: event(2, "answer.delta", {
        delta: "intermediate",
        provisional: true,
      }),
    });
    state = agentStreamReducer(state, {
      type: "event.received",
      event: event(3, "answer.delta", {
        delta: "",
        reset: true,
        provisional: true,
      }),
    });
    state = agentStreamReducer(state, {
      type: "event.received",
      event: event(4, "assistant.completed", { finalAnswer: "Done." }),
    });

    const assistant = state.timelines["thread-1"].items[0];
    expect(assistant.type).toBe("assistant");
    if (assistant.type !== "assistant") throw new Error("expected assistant");
    expect(assistant.draftAnswer).toBe("");
    expect(assistant.finalAnswer).toBe("Done.");
    expect(assistant.processDisclosure).toBe("collapsed");
  });

  it("honors a user disclosure override when the final answer arrives", () => {
    let state = agentStreamReducer(initialStreamState, {
      type: "event.received",
      event: event(1, "reasoning.delta", {
        stepId: "thought",
        delta: "Checking files",
      }),
    });
    state = agentStreamReducer(state, {
      type: "disclosure.changed",
      threadId: "thread-1",
      runId: "run-1",
      disclosure: "expanded",
    });
    state = agentStreamReducer(state, {
      type: "event.received",
      event: event(2, "assistant.completed", { finalAnswer: "Finished" }),
    });

    const assistant = state.timelines["thread-1"].items[0];
    if (assistant.type !== "assistant") throw new Error("expected assistant");
    expect(assistant.processUserOverride).toBe(true);
    expect(processIsOpen(assistant)).toBe(true);
  });

  it("accepts persisted ProcessStep payloads and de-duplicates sequences", () => {
    const completed = event(2, "tool.completed", {
      step: {
        id: "tool-1",
        type: "tool",
        title: "Read package.json",
        toolName: "read_file",
        toolCallId: "tool-1",
        status: "success",
        output: "{}",
        durationMs: 12,
      },
    });
    let state = agentStreamReducer(initialStreamState, {
      type: "event.received",
      event: event(1, "tool.started", {
        step: {
          id: "tool-1",
          type: "tool",
          title: "Read package.json",
          toolName: "read_file",
          toolCallId: "tool-1",
          status: "running",
        },
      }),
    });
    state = agentStreamReducer(state, {
      type: "event.received",
      event: completed,
    });
    state = agentStreamReducer(state, {
      type: "event.received",
      event: completed,
    });

    const assistant = state.timelines["thread-1"].items[0];
    if (assistant.type !== "assistant") throw new Error("expected assistant");
    expect(assistant.steps).toHaveLength(1);
    expect(assistant.steps[0]).toMatchObject({
      id: "tool-1",
      status: "success",
      output: "{}",
    });
  });

  it("tracks sequence numbers independently for each run in a thread", () => {
    let state = agentStreamReducer(initialStreamState, {
      type: "event.received",
      event: event(1, "run.started", {}, "run-1"),
    });
    state = agentStreamReducer(state, {
      type: "event.received",
      event: event(1, "run.started", {}, "run-2"),
    });
    expect(state.timelines["thread-1"].items).toHaveLength(2);
  });

  it("preserves live events that arrive while a timeline is loading", () => {
    let state = agentStreamReducer(initialStreamState, {
      type: "event.received",
      event: event(1, "answer.delta", { delta: "still streaming" }, "run-live"),
    });
    state = agentStreamReducer(state, {
      type: "timeline.loaded",
      timeline: {
        version: 1,
        threadId: "thread-1",
        items: [
          {
            id: "old-user",
            type: "user",
            content: "Older message",
            createdAt: new Date(1_600_000_000_000).toISOString(),
          },
        ],
      },
    });
    expect(state.timelines["thread-1"].items).toHaveLength(2);
    expect(state.timelines["thread-1"].items[1]).toMatchObject({
      runId: "run-live",
    });
  });

  it("preserves structured file references on optimistic user messages", () => {
    const state = agentStreamReducer(initialStreamState, {
      type: "user.optimistic",
      threadId: "thread-1",
      id: "user-file-reference",
      content: "Review @[src/agent.ts]",
      parts: [
        { type: "text", text: "Review " },
        {
          type: "file",
          name: "agent.ts",
          relativePath: "src/agent.ts",
        },
      ],
      createdAt: new Date(1_600_000_000_000).toISOString(),
    });

    expect(state.timelines["thread-1"].items[0]).toMatchObject({
      type: "user",
      parts: [
        { type: "text", text: "Review " },
        {
          type: "file",
          name: "agent.ts",
          relativePath: "src/agent.ts",
        },
      ],
    });
  });

  it("replaces rather than merges a timeline cleared by an explicit context command", () => {
    let state = agentStreamReducer(initialStreamState, {
      type: "event.received",
      event: event(7, "answer.delta", { delta: "old context" }, "run-old"),
    });

    state = agentStreamReducer(state, {
      type: "timeline.cleared",
      timeline: { version: 1, threadId: "thread-1", items: [] },
    });

    expect(state.timelines["thread-1"].items).toEqual([]);
    expect(state.lastSequence["thread-1:run-old"]).toBeUndefined();
  });

  it("keeps the latest context snapshot without creating a synthetic assistant turn", () => {
    let state = agentStreamReducer(initialStreamState, {
      type: "event.received",
      event: event(
        1,
        "context.updated",
        {
          usedTokens: 120,
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 60,
          cacheWriteTokens: 10,
          source: "provider",
          updatedAt: "2026-08-20T10:00:00.000Z",
        },
        "run-new",
      ),
    });
    state = agentStreamReducer(state, {
      type: "event.received",
      event: event(
        1,
        "context.updated",
        {
          usedTokens: 900,
          inputTokens: 800,
          outputTokens: 100,
          source: "provider",
          updatedAt: "2026-08-20T09:00:00.000Z",
        },
        "run-old",
      ),
    });

    expect(state.timelines["thread-1"].items).toEqual([]);
    expect(state.timelines["thread-1"].contextWindow).toMatchObject({
      usedTokens: 120,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 60,
      cacheWriteTokens: 10,
      source: "provider",
    });

    state = agentStreamReducer(state, {
      type: "timeline.loaded",
      timeline: {
        version: 1,
        threadId: "thread-1",
        items: [],
        contextWindow: {
          usedTokens: 10,
          inputTokens: 10,
          outputTokens: 0,
          source: "estimated-history",
          updatedAt: "2026-08-20T08:00:00.000Z",
        },
      },
    });
    expect(state.timelines["thread-1"].contextWindow?.usedTokens).toBe(120);
  });

  it("marks an explicit compaction snapshot as estimated history", () => {
    const state = agentStreamReducer(initialStreamState, {
      type: "context.compacted",
      threadId: "thread-1",
      afterTokens: 48,
      updatedAt: "2026-08-20T11:00:00.000Z",
    });

    expect(state.timelines["thread-1"].contextWindow).toEqual({
      usedTokens: 48,
      inputTokens: 48,
      outputTokens: 0,
      source: "estimated-history",
      updatedAt: "2026-08-20T11:00:00.000Z",
    });
  });

  it.each(["denied", "error", "cancelled"] as const)(
    "keeps a completed run expanded when a step is %s",
    (stepStatus) => {
      let state = agentStreamReducer(initialStreamState, {
        type: "event.received",
        event: event(1, "tool.completed", {
          step: {
            id: "tool-problem",
            type: "tool",
            title: "Risky operation",
            status: stepStatus,
          },
        }),
      });
      state = agentStreamReducer(state, {
        type: "event.received",
        event: event(2, "assistant.completed", {
          finalAnswer: "Could not finish.",
        }),
      });
      state = agentStreamReducer(state, {
        type: "event.received",
        event: event(3, "run.completed", { status: "completed" }),
      });

      const assistant = state.timelines["thread-1"].items[0];
      if (assistant.type !== "assistant") throw new Error("expected assistant");
      expect(assistant.processDisclosure).toBe("expanded");
    },
  );

  it("honors processDisclosure supplied by the persisted event payload", () => {
    let state = agentStreamReducer(initialStreamState, {
      type: "event.received",
      event: event(1, "assistant.completed", { finalAnswer: "Done." }),
    });
    state = agentStreamReducer(state, {
      type: "event.received",
      event: event(2, "run.completed", {
        status: "completed",
        processDisclosure: "expanded",
      }),
    });
    const assistant = state.timelines["thread-1"].items[0];
    if (assistant.type !== "assistant") throw new Error("expected assistant");
    expect(assistant.processDisclosure).toBe("expanded");
  });

  it("shows the concrete error sent by run.failed", () => {
    const state = agentStreamReducer(initialStreamState, {
      type: "event.received",
      event: event(1, "run.failed", {
        status: "error",
        error: "Provider authentication failed",
      }),
    });
    const assistant = state.timelines["thread-1"].items[0];
    if (assistant.type !== "assistant") throw new Error("expected assistant");
    expect(assistant.error).toBe("Provider authentication failed");
  });

  it("settles reasoning when tool execution starts", () => {
    let state = agentStreamReducer(initialStreamState, {
      type: "event.received",
      event: event(1, "reasoning.delta", {
        stepId: "thought",
        delta: "Inspecting",
      }),
    });
    state = agentStreamReducer(state, {
      type: "event.received",
      event: event(2, "tool.started", {
        step: {
          id: "tool-1",
          type: "tool",
          title: "Read files",
          status: "running",
        },
      }),
    });
    const assistant = state.timelines["thread-1"].items[0];
    if (assistant.type !== "assistant") throw new Error("expected assistant");
    expect(assistant.steps[0].status).toBe("success");
    expect(assistant.steps[1].status).toBe("running");
  });

  it("does not resurrect a provisional draft after a live reset merges with hydration", () => {
    let state = agentStreamReducer(initialStreamState, {
      type: "event.received",
      event: event(1, "answer.delta", { delta: "provisional" }),
    });
    state = agentStreamReducer(state, {
      type: "event.received",
      event: event(2, "answer.delta", { delta: "", reset: true }),
    });
    state = agentStreamReducer(state, {
      type: "timeline.loaded",
      timeline: {
        version: 1,
        threadId: "thread-1",
        items: [
          {
            id: "assistant:run-1",
            type: "assistant",
            runId: "run-1",
            status: "running",
            createdAt: new Date(1_700_000_000_000).toISOString(),
            steps: [],
            finalAnswer: "",
            draftAnswer: "stale provisional",
            processDisclosure: "auto",
            processUserOverride: false,
          },
        ],
      },
    });
    const assistant = state.timelines["thread-1"].items[0];
    if (assistant.type !== "assistant") throw new Error("expected assistant");
    expect(assistant.draftAnswer).toBe("");
  });

  it("retains approval tags needed to hide non-persistable always-allow actions", () => {
    const state = agentStreamReducer(initialStreamState, {
      type: "event.received",
      event: event(1, "approval.requested", {
        approvalId: "approval-1",
        toolName: "mcp.remote_tool",
        description: "Call an MCP server",
        riskLevel: "low",
        tags: ["mcp", "network"],
        input: {},
      }),
    });
    const assistant = state.timelines["thread-1"].items[0];
    if (assistant.type !== "assistant") throw new Error("expected assistant");
    expect(
      (
        assistant.steps[0] as (typeof assistant.steps)[number] & {
          approvalTags?: string[];
        }
      ).approvalTags,
    ).toEqual(["mcp", "network"]);
  });
});
