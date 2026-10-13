import type {
  AgentEventEnvelope,
  AssistantTimelineItem,
  ContextWindowSnapshot,
  ProcessStep,
  PendingMessage,
  UserTimelineItem,
  ProcessStepStatus,
  ProcessStepType,
  ThreadTimeline,
  TimelineItem,
  UserMessagePart,
} from "@shared/contracts";

export interface StreamState {
  timelines: Record<string, ThreadTimeline>;
  lastSequence: Record<string, number>;
}

export type StreamAction =
  | { type: "timeline.loaded"; timeline: ThreadTimeline }
  | { type: "timeline.cleared"; timeline: ThreadTimeline }
  | {
      type: "context.compacted";
      threadId: string;
      afterTokens: number;
      updatedAt: string;
    }
  | { type: "event.received"; event: AgentEventEnvelope }
  | {
      type: "user.optimistic";
      threadId: string;
      id: string;
      content: string;
      parts?: UserMessagePart[];
      createdAt: string;
    }
  | { type: "run.ensure"; threadId: string; runId: string; createdAt: string }
  | {
      type: "run.start-failed";
      threadId: string;
      runId: string;
      message: string;
      createdAt: string;
    }
  | {
      type: "disclosure.changed";
      threadId: string;
      runId: string;
      disclosure: "expanded" | "collapsed";
    };

export const initialStreamState: StreamState = {
  timelines: {},
  lastSequence: {},
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function stringValue(
  record: UnknownRecord,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function numberValue(
  record: UnknownRecord,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number") return value;
  }
  return undefined;
}

function booleanValue(
  record: UnknownRecord,
  ...keys: string[]
): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function eventText(payload: UnknownRecord): string {
  return (
    stringValue(
      payload,
      "delta",
      "text",
      "content",
      "answer",
      "finalAnswer",
      "message",
    ) ?? ""
  );
}

function timelineFor(state: StreamState, threadId: string): ThreadTimeline {
  return state.timelines[threadId] ?? { version: 1, threadId, items: [] };
}

function latestContextWindow(
  current?: ContextWindowSnapshot,
  incoming?: ContextWindowSnapshot,
): ContextWindowSnapshot | undefined {
  if (!incoming) return current;
  if (!current) return incoming;
  return Date.parse(incoming.updatedAt) >= Date.parse(current.updatedAt)
    ? incoming
    : current;
}

function snapshotFromEvent(
  event: AgentEventEnvelope,
): ContextWindowSnapshot | undefined {
  const payload = asRecord(event.payload);
  const usedTokens = numberValue(payload, "usedTokens");
  const inputTokens = numberValue(payload, "inputTokens");
  const outputTokens = numberValue(payload, "outputTokens");
  const maxTokens = numberValue(payload, "maxTokens");
  const cacheReadTokens = numberValue(payload, "cacheReadTokens");
  const cacheWriteTokens = numberValue(payload, "cacheWriteTokens");
  const updatedAt = stringValue(payload, "updatedAt") ?? event.timestamp;
  if (
    usedTokens === undefined ||
    inputTokens === undefined ||
    outputTokens === undefined ||
    ![
      usedTokens,
      inputTokens,
      outputTokens,
      maxTokens,
      cacheReadTokens,
      cacheWriteTokens,
    ]
      .filter((value): value is number => value !== undefined)
      .every((value) => Number.isFinite(value) && value >= 0) ||
    (payload.source !== "provider" && payload.source !== "estimated-history") ||
    Number.isNaN(Date.parse(updatedAt))
  ) {
    return undefined;
  }
  return {
    usedTokens: Math.floor(usedTokens),
    inputTokens: Math.floor(inputTokens),
    outputTokens: Math.floor(outputTokens),
    ...(maxTokens !== undefined ? { maxTokens: Math.floor(maxTokens) } : {}),
    ...(cacheReadTokens !== undefined
      ? { cacheReadTokens: Math.floor(cacheReadTokens) }
      : {}),
    ...(cacheWriteTokens !== undefined
      ? { cacheWriteTokens: Math.floor(cacheWriteTokens) }
      : {}),
    source: payload.source,
    updatedAt,
  };
}

function mergeLoadedTimeline(
  loaded: ThreadTimeline,
  current?: ThreadTimeline,
): ThreadTimeline {
  const contextWindow = latestContextWindow(
    loaded.contextWindow,
    current?.contextWindow,
  );
  if (!current?.items.length) return { ...loaded, contextWindow };
  const items = [...loaded.items];
  for (const liveItem of current.items) {
    if (liveItem.type === "assistant") {
      const index = items.findIndex(
        (item) => item.type === "assistant" && item.runId === liveItem.runId,
      );
      if (index < 0) {
        items.push(liveItem);
        continue;
      }
      const persisted = items[index] as AssistantTimelineItem;
      const steps = [...persisted.steps];
      for (const liveStep of liveItem.steps) {
        const stepIndex = steps.findIndex(
          (step) =>
            step.id === liveStep.id ||
            (liveStep.toolCallId && step.toolCallId === liveStep.toolCallId) ||
            (liveStep.approvalId && step.approvalId === liveStep.approvalId),
        );
        if (stepIndex < 0) steps.push(liveStep);
        else steps[stepIndex] = { ...steps[stepIndex], ...liveStep };
      }
      items[index] = {
        ...persisted,
        ...liveItem,
        steps,
        finalAnswer: liveItem.finalAnswer || persisted.finalAnswer,
        // An empty live draft is meaningful: the normalizer emits reset=true
        // when provisional model text turns into a tool/reasoning phase.
        draftAnswer: liveItem.draftAnswer,
        usage: liveItem.usage ?? persisted.usage,
      };
      continue;
    }

    const duplicate = items.some((item) => {
      if (item.type !== "user") return false;
      if (item.id === liveItem.id) return true;
      const timeDelta = Math.abs(
        new Date(item.createdAt).getTime() -
          new Date(liveItem.createdAt).getTime(),
      );
      return item.content === liveItem.content && timeDelta < 2_000;
    });
    if (!duplicate) items.push(liveItem);
  }
  return { ...loaded, items, contextWindow };
}

function createAssistant(
  runId: string,
  createdAt: string,
): AssistantTimelineItem {
  return {
    id: `assistant:${runId}`,
    type: "assistant",
    runId,
    status: "running",
    createdAt,
    steps: [],
    finalAnswer: "",
    draftAnswer: "",
    processDisclosure: "auto",
    processUserOverride: false,
  };
}

function completionDisclosure(
  assistant: AssistantTimelineItem,
  payload: UnknownRecord,
): AssistantTimelineItem["processDisclosure"] {
  if (assistant.processUserOverride) return assistant.processDisclosure;
  if (
    payload.processDisclosure === "expanded" ||
    payload.processDisclosure === "collapsed"
  ) {
    return payload.processDisclosure;
  }
  const payloadStatus = stringValue(payload, "status");
  const unsuccessful =
    payloadStatus === "error" ||
    payloadStatus === "cancelled" ||
    payloadStatus === "denied" ||
    Boolean(stringValue(payload, "error")) ||
    assistant.steps.some(
      (step) =>
        step.status === "error" ||
        step.status === "denied" ||
        step.status === "cancelled",
    );
  return unsuccessful || !assistant.finalAnswer ? "expanded" : "collapsed";
}

function findAssistant(items: TimelineItem[], runId: string): number {
  return items.findIndex(
    (item) => item.type === "assistant" && item.runId === runId,
  );
}

function ensureAssistant(
  items: TimelineItem[],
  runId: string,
  createdAt: string,
): number {
  const existing = findAssistant(items, runId);
  if (existing >= 0) return existing;
  items.push(createAssistant(runId, createdAt));
  return items.length - 1;
}

function stepStatus(
  value: unknown,
  fallback: ProcessStepStatus,
): ProcessStepStatus {
  switch (value) {
    case "pending":
    case "running":
    case "success":
    case "error":
    case "denied":
    case "cancelled":
      return value;
    default:
      return fallback;
  }
}

function toolStepId(runId: string, payload: UnknownRecord): string {
  return (
    stringValue(payload, "toolCallId", "callId", "id") ??
    `${runId}:tool:${Date.now()}`
  );
}

function upsertStep(
  assistant: AssistantTimelineItem,
  id: string,
  create: () => ProcessStep,
  update?: (step: ProcessStep) => ProcessStep,
): AssistantTimelineItem {
  const steps = [...assistant.steps];
  const index = steps.findIndex(
    (step) =>
      step.id === id || step.toolCallId === id || step.approvalId === id,
  );
  if (index < 0) steps.push(create());
  else if (update) steps[index] = update(steps[index]);
  return { ...assistant, steps };
}

function settleRunningReasoning(
  assistant: AssistantTimelineItem,
  completedAt: string,
): AssistantTimelineItem {
  return {
    ...assistant,
    steps: assistant.steps.map((step) =>
      step.type === "reasoning" && step.status === "running"
        ? { ...step, status: "success", completedAt }
        : step,
    ),
  };
}

function updateEventTimeline(
  timeline: ThreadTimeline,
  event: AgentEventEnvelope,
): ThreadTimeline {
  if (event.type === "messages.pending")
    return { ...timeline, pendingMessages: event.payload as PendingMessage[] };
  if (event.type === "message.sent") {
    const user = event.payload as UserTimelineItem;
    if (timeline.items.some((item) => item.id === user.id)) return timeline;
    const items = [...timeline.items];
    const index = items.findIndex(
      (item) => item.type === "assistant" && item.runId === event.runId,
    );
    items.splice(index < 0 ? items.length : index, 0, user);
    return { ...timeline, items };
  }
  if (event.type === "context.updated") {
    const incoming = snapshotFromEvent(event);
    return incoming
      ? {
          ...timeline,
          contextWindow: latestContextWindow(timeline.contextWindow, incoming),
        }
      : timeline;
  }
  const items = [...timeline.items];
  const payload = asRecord(event.payload);
  const index = ensureAssistant(items, event.runId, event.timestamp);
  let assistant = { ...(items[index] as AssistantTimelineItem) };

  switch (event.type) {
    case "run.started": {
      assistant = { ...assistant, status: "running" };
      break;
    }
    case "model.started": {
      const id = stringValue(payload, "stepId");
      if (id) {
        assistant = upsertStep(assistant, id, () => ({
          id,
          type: "reasoning",
          title: stringValue(payload, "title", "model") ?? "Thinking",
          status: "running",
          startedAt: event.timestamp,
        }));
      }
      break;
    }
    case "reasoning.delta": {
      const id =
        stringValue(payload, "stepId", "id") ?? `${event.runId}:reasoning`;
      const delta = eventText(payload);
      assistant = upsertStep(
        assistant,
        id,
        () => ({
          id,
          type: "reasoning",
          title: stringValue(payload, "title") ?? "Thinking",
          content: delta,
          status: "running",
          startedAt: event.timestamp,
        }),
        (step) => ({
          ...step,
          content: `${step.content ?? ""}${delta}`,
          status: "running",
        }),
      );
      break;
    }
    case "answer.delta": {
      const reset = Boolean(booleanValue(payload, "reset"));
      assistant = {
        ...assistant,
        draftAnswer: reset
          ? ""
          : `${assistant.draftAnswer}${eventText(payload)}`,
      };
      if (reset) assistant = settleRunningReasoning(assistant, event.timestamp);
      break;
    }
    case "tool.started": {
      assistant = settleRunningReasoning(assistant, event.timestamp);
      const source = asRecord(payload.step ?? payload);
      const id = toolStepId(event.runId, source);
      const input = asRecord(source.input ?? source.arguments ?? source.args);
      assistant = upsertStep(assistant, id, () => ({
        id,
        toolCallId: id,
        toolName: stringValue(source, "toolName", "name", "tool") ?? "tool",
        type:
          source.type === "subagent" || source.type === "status"
            ? source.type
            : "tool",
        title:
          stringValue(source, "title", "description") ??
          stringValue(source, "toolName", "name") ??
          "Running tool",
        content: stringValue(source, "content", "description"),
        input,
        status: stepStatus(source.status, "running"),
        startedAt: stringValue(source, "startedAt") ?? event.timestamp,
      }));
      break;
    }
    case "tool.completed": {
      const source = asRecord(payload.step ?? payload);
      const id = toolStepId(event.runId, source);
      const failed =
        Boolean(booleanValue(source, "isError", "error") ?? false) ||
        numberValue(source, "exitCode")! > 0 ||
        source.status === "error";
      assistant = upsertStep(
        assistant,
        id,
        () => ({
          id,
          toolCallId: id,
          toolName: stringValue(source, "toolName", "name", "tool") ?? "tool",
          type:
            source.type === "subagent" || source.type === "status"
              ? source.type
              : "tool",
          title:
            stringValue(source, "title", "description") ??
            stringValue(source, "toolName", "name") ??
            "Tool",
          input: asRecord(source.input),
          output: source.output ?? source.result ?? source,
          status: failed ? "error" : stepStatus(source.status, "success"),
          completedAt: stringValue(source, "completedAt") ?? event.timestamp,
          durationMs: numberValue(source, "durationMs", "duration"),
        }),
        (step) => ({
          ...step,
          title: stringValue(source, "title", "description") ?? step.title,
          input: Object.keys(asRecord(source.input)).length
            ? asRecord(source.input)
            : step.input,
          output: source.output ?? source.result ?? source,
          content: stringValue(source, "content", "message") ?? step.content,
          status: failed ? "error" : stepStatus(source.status, "success"),
          completedAt: stringValue(source, "completedAt") ?? event.timestamp,
          durationMs:
            numberValue(source, "durationMs", "duration") ?? step.durationMs,
        }),
      );
      break;
    }
    case "approval.requested": {
      const request = asRecord(payload.request ?? payload);
      const id =
        stringValue(request, "approvalId", "id") ?? `${event.runId}:approval`;
      assistant = upsertStep(
        assistant,
        id,
        () =>
          ({
            id,
            approvalId: id,
            toolCallId: stringValue(request, "toolCallId", "callId"),
            toolName: stringValue(request, "toolName", "tool", "name"),
            type: "approval",
            title:
              stringValue(request, "description", "title") ??
              "Approval required",
            content: stringValue(request, "content", "message"),
            input: asRecord(request.input),
            riskLevel:
              request.riskLevel === "high" || request.riskLevel === "medium"
                ? request.riskLevel
                : "low",
            approvalTags: Array.isArray(request.tags)
              ? request.tags.filter(
                  (tag): tag is string => typeof tag === "string",
                )
              : [],
            status: "pending",
            startedAt: event.timestamp,
          }) as ProcessStep & { approvalTags: string[] },
      );
      break;
    }
    case "approval.resolved": {
      const id =
        stringValue(payload, "approvalId", "id") ?? `${event.runId}:approval`;
      const decision = stringValue(payload, "decision", "status");
      assistant = upsertStep(
        assistant,
        id,
        () => ({
          id,
          approvalId: id,
          type: "approval",
          title: "Approval resolved",
          status:
            decision === "deny" || decision === "denied" ? "denied" : "success",
          completedAt: event.timestamp,
        }),
        (step) => ({
          ...step,
          status:
            decision === "deny" || decision === "denied" ? "denied" : "success",
          completedAt: event.timestamp,
        }),
      );
      break;
    }
    case "assistant.completed": {
      const finalAnswer = eventText(payload) || assistant.draftAnswer;
      const usage = asRecord(payload.usage);
      const completedAssistant: AssistantTimelineItem = {
        ...settleRunningReasoning(assistant, event.timestamp),
        finalAnswer,
        draftAnswer: "",
        usage:
          usage.totalTokens !== undefined
            ? {
                promptTokens:
                  numberValue(usage, "promptTokens", "inputTokens") ?? 0,
                completionTokens:
                  numberValue(usage, "completionTokens", "outputTokens") ?? 0,
                totalTokens: numberValue(usage, "totalTokens") ?? 0,
              }
            : assistant.usage,
      };
      assistant = {
        ...completedAssistant,
        processDisclosure: completionDisclosure(completedAssistant, payload),
      };
      break;
    }
    case "run.completed": {
      const answer = eventText(payload);
      const runStatus = stringValue(payload, "status");
      const completedAssistant: AssistantTimelineItem = {
        ...assistant,
        status:
          runStatus === "error" || runStatus === "cancelled"
            ? runStatus
            : "completed",
        completedAt: event.timestamp,
        finalAnswer: answer || assistant.finalAnswer || assistant.draftAnswer,
        draftAnswer: "",
        error: stringValue(payload, "error") ?? assistant.error,
        usage:
          asRecord(payload.usage).totalTokens !== undefined
            ? {
                promptTokens:
                  numberValue(
                    asRecord(payload.usage),
                    "promptTokens",
                    "inputTokens",
                  ) ?? 0,
                completionTokens:
                  numberValue(
                    asRecord(payload.usage),
                    "completionTokens",
                    "outputTokens",
                  ) ?? 0,
                totalTokens:
                  numberValue(asRecord(payload.usage), "totalTokens") ?? 0,
              }
            : assistant.usage,
        steps: assistant.steps.map((step) =>
          step.status === "running"
            ? { ...step, status: "success", completedAt: event.timestamp }
            : step,
        ),
      };
      assistant = {
        ...completedAssistant,
        processDisclosure: completionDisclosure(completedAssistant, payload),
      };
      break;
    }
    case "run.cancelled": {
      assistant = {
        ...assistant,
        status: "cancelled",
        completedAt: event.timestamp,
        processDisclosure: assistant.processUserOverride
          ? assistant.processDisclosure
          : "expanded",
        steps: assistant.steps.map((step) =>
          step.status === "running" || step.status === "pending"
            ? { ...step, status: "cancelled", completedAt: event.timestamp }
            : step,
        ),
      };
      break;
    }
    case "run.failed": {
      assistant = {
        ...assistant,
        status: "error",
        completedAt: event.timestamp,
        error:
          stringValue(payload, "error") ??
          (eventText(payload) || "The run failed."),
        processDisclosure: assistant.processUserOverride
          ? assistant.processDisclosure
          : "expanded",
        steps: assistant.steps.map((step) =>
          step.status === "running" || step.status === "pending"
            ? { ...step, status: "error", completedAt: event.timestamp }
            : step,
        ),
      };
      break;
    }
    case "evolution.proposal":
      break;
  }

  items[index] = assistant;
  return { ...timeline, items };
}

export function agentStreamReducer(
  state: StreamState,
  action: StreamAction,
): StreamState {
  switch (action.type) {
    case "timeline.loaded":
      return {
        ...state,
        timelines: {
          ...state.timelines,
          [action.timeline.threadId]: mergeLoadedTimeline(
            action.timeline,
            state.timelines[action.timeline.threadId],
          ),
        },
      };
    case "timeline.cleared": {
      const sequencePrefix = `${action.timeline.threadId}:`;
      return {
        timelines: {
          ...state.timelines,
          [action.timeline.threadId]: action.timeline,
        },
        lastSequence: Object.fromEntries(
          Object.entries(state.lastSequence).filter(
            ([key]) => !key.startsWith(sequencePrefix),
          ),
        ),
      };
    }
    case "context.compacted": {
      const timeline = timelineFor(state, action.threadId);
      const afterTokens = Math.max(0, Math.floor(action.afterTokens));
      const snapshot: ContextWindowSnapshot = {
        usedTokens: afterTokens,
        inputTokens: afterTokens,
        outputTokens: 0,
        ...(timeline.contextWindow?.maxTokens !== undefined
          ? { maxTokens: timeline.contextWindow.maxTokens }
          : {}),
        source: "estimated-history",
        updatedAt: action.updatedAt,
      };
      return {
        ...state,
        timelines: {
          ...state.timelines,
          [action.threadId]: {
            ...timeline,
            contextWindow: latestContextWindow(
              timeline.contextWindow,
              snapshot,
            ),
          },
        },
      };
    }
    case "user.optimistic": {
      const timeline = timelineFor(state, action.threadId);
      if (timeline.items.some((item) => item.id === action.id)) return state;
      return {
        ...state,
        timelines: {
          ...state.timelines,
          [action.threadId]: {
            ...timeline,
            items: [
              ...timeline.items,
              {
                id: action.id,
                type: "user",
                content: action.content,
                ...(action.parts?.length ? { parts: action.parts } : {}),
                createdAt: action.createdAt,
              },
            ],
          },
        },
      };
    }
    case "run.ensure": {
      const timeline = timelineFor(state, action.threadId);
      const items = [...timeline.items];
      ensureAssistant(items, action.runId, action.createdAt);
      return {
        ...state,
        timelines: {
          ...state.timelines,
          [action.threadId]: { ...timeline, items },
        },
      };
    }
    case "run.start-failed": {
      const timeline = timelineFor(state, action.threadId);
      const items = [...timeline.items];
      const index = ensureAssistant(items, action.runId, action.createdAt);
      items[index] = {
        ...(items[index] as AssistantTimelineItem),
        status: "error",
        completedAt: action.createdAt,
        error: action.message,
      };
      return {
        ...state,
        timelines: {
          ...state.timelines,
          [action.threadId]: { ...timeline, items },
        },
      };
    }
    case "disclosure.changed": {
      const timeline = timelineFor(state, action.threadId);
      return {
        ...state,
        timelines: {
          ...state.timelines,
          [action.threadId]: {
            ...timeline,
            items: timeline.items.map((item) =>
              item.type === "assistant" && item.runId === action.runId
                ? {
                    ...item,
                    processDisclosure: action.disclosure,
                    processUserOverride: true,
                  }
                : item,
            ),
          },
        },
      };
    }
    case "event.received": {
      const { event } = action;
      const sequenceKey = `${event.threadId}:${event.runId}`;
      const last = state.lastSequence[sequenceKey];
      if (last !== undefined && event.sequence <= last) return state;
      const timeline = updateEventTimeline(
        timelineFor(state, event.threadId),
        event,
      );
      return {
        timelines: { ...state.timelines, [event.threadId]: timeline },
        lastSequence: { ...state.lastSequence, [sequenceKey]: event.sequence },
      };
    }
  }
}

export function hasRunningRun(timeline: ThreadTimeline | undefined): boolean {
  return Boolean(
    timeline?.items.some(
      (item) => item.type === "assistant" && item.status === "running",
    ),
  );
}

export function latestRun(
  timeline: ThreadTimeline | undefined,
): AssistantTimelineItem | undefined {
  return [...(timeline?.items ?? [])]
    .reverse()
    .find((item): item is AssistantTimelineItem => item.type === "assistant");
}

export function processIsOpen(item: AssistantTimelineItem): boolean {
  if (item.processDisclosure === "expanded") return true;
  if (item.processDisclosure === "collapsed") return false;
  return (
    item.status === "running" || (!item.finalAnswer && item.steps.length > 0)
  );
}

export function stepTypeLabel(type: ProcessStepType): string {
  switch (type) {
    case "reasoning":
      return "Thought";
    case "tool":
      return "Tool";
    case "approval":
      return "Approval";
    case "status":
      return "Status";
    case "subagent":
      return "Agent";
  }
}
