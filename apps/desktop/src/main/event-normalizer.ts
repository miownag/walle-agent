import { randomUUID } from "node:crypto";
import type {
  AgentStreamEvent,
  ModelMessage,
  TokenUsage,
} from "@walle-agent/core";
import type {
  AgentEventEnvelope,
  AssistantTimelineItem,
  ContextWindowSnapshot,
  ProcessStep,
} from "../shared/contracts";

interface PhaseState {
  turn: number;
  step: ProcessStep;
  text: string;
  thinking: string;
}

interface NormalizerIdentity {
  threadId: string;
  sessionId: string;
  runId: string;
}

function messageText(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return (message.content ?? [])
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

function messageThinking(message: ModelMessage): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block.type === "thinking")
    .map((block) => block.thinking)
    .join("");
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : JSON.stringify(error);
}

function toolStepStatus(status: string): ProcessStep["status"] {
  if (status === "success") return "success";
  if (status === "denied") return "denied";
  if (status === "cancelled" || status === "timeout") return "cancelled";
  return "error";
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function providerContextSnapshot(
  usage: TokenUsage | undefined,
  updatedAt: string,
): ContextWindowSnapshot | undefined {
  if (!usage) return undefined;
  const inputTokens = tokenCount(usage.promptTokens);
  const outputTokens = tokenCount(usage.completionTokens);
  const cacheReadTokens = tokenCount(usage.cacheReadTokens);
  const cacheWriteTokens = tokenCount(usage.cacheWriteTokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const reportedTotal = tokenCount(usage.totalTokens);
  return {
    usedTokens: reportedTotal ?? inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    source: "provider",
    updatedAt,
  };
}

function jsonSafe(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  const seen = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(value, (_key, entry: unknown) => {
      if (typeof entry === "bigint") return entry.toString();
      if (entry instanceof Error)
        return { name: entry.name, message: entry.message, stack: entry.stack };
      if (entry && typeof entry === "object") {
        if (seen.has(entry)) return "[circular]";
        seen.add(entry);
      }
      return entry;
    });
    if (serialized === undefined) return String(value);
    if (serialized.length > 256_000) {
      return {
        truncated: true,
        totalCharacters: serialized.length,
        preview: serialized.slice(0, 256_000),
      };
    }
    return JSON.parse(serialized) as unknown;
  } catch {
    return String(value);
  }
}

export class AgentEventNormalizer {
  private sequence = 0;
  private phase?: PhaseState;
  private pendingError?: string;
  private finalEmitted = false;
  private currentTurn?: number;
  /**
   * Core preserves llm_chunk for compatibility and may additionally emit a
   * first-class thinking_delta immediately afterwards. Keep the compatibility
   * chunk pending for one event so the pair is folded into a single delta.
   */
  private pendingCompatibilityThinking?: string;

  constructor(
    private readonly identity: NormalizerIdentity,
    readonly assistant: AssistantTimelineItem,
  ) {}

  started(prompt: string): AgentEventEnvelope {
    return this.envelope("run.started", { prompt });
  }

  consume(
    event: AgentStreamEvent | { type: string; [key: string]: unknown },
  ): AgentEventEnvelope[] {
    const leading: AgentEventEnvelope[] = [];
    if (this.pendingCompatibilityThinking !== undefined) {
      const firstClassDelta =
        event.type === "thinking_delta"
          ? String((event as { content?: unknown }).content ?? "")
          : undefined;
      const pending = this.pendingCompatibilityThinking;
      this.pendingCompatibilityThinking = undefined;
      if (firstClassDelta === pending) {
        return this.appendThinking(firstClassDelta);
      }
      leading.push(...this.appendThinking(pending));
    }
    switch (event.type) {
      case "run_start":
        return [];
      case "model_call_start": {
        const turn = Number((event as { turn?: number }).turn ?? 0);
        this.currentTurn = turn;
        const step: ProcessStep = {
          id: randomUUID(),
          type: "reasoning",
          title: "Thinking",
          status: "running",
          startedAt: new Date().toISOString(),
        };
        this.phase = { turn, step, text: "", thinking: "" };
        this.assistant.steps.push(step);
        return [
          this.envelope("model.started", { turn, stepId: step.id }, turn),
        ];
      }
      case "thinking_delta": {
        const delta = String((event as { content?: unknown }).content ?? "");
        return [...leading, ...this.appendThinking(delta)];
      }
      case "llm_chunk": {
        const chunk = (
          event as {
            chunk?: { type?: string; content?: string; usage?: TokenUsage };
          }
        ).chunk;
        if (chunk?.type === "thinking_delta") {
          this.pendingCompatibilityThinking = chunk.content ?? "";
          return leading;
        }
        if (chunk?.type === "message_complete" && chunk.usage)
          this.addUsage(chunk.usage);
        return leading;
      }
      case "text_delta": {
        const delta = String((event as { content?: unknown }).content ?? "");
        if (!this.phase || !delta) return leading;
        this.phase.text += delta;
        this.assistant.draftAnswer += delta;
        return [
          ...leading,
          this.envelope(
            "answer.delta",
            {
              delta,
              provisional: true,
              phaseId: this.phase.step.id,
            },
            this.phase.turn,
          ),
        ];
      }
      case "model_call_end": {
        const completed = event as {
          message: ModelMessage;
          usage?: TokenUsage;
        };
        const contextWindow = providerContextSnapshot(
          completed.usage,
          new Date().toISOString(),
        );
        return [
          ...leading,
          ...this.finishPhase(completed.message),
          ...(contextWindow
            ? [this.envelope("context.updated", contextWindow)]
            : []),
        ];
      }
      case "tool_call_start":
        return [
          ...leading,
          ...this.startTool(
            (event as Extract<AgentStreamEvent, { type: "tool_call_start" }>)
              .call,
          ),
        ];
      case "tool_call_end":
        return [
          ...leading,
          ...this.finishTool(
            (event as Extract<AgentStreamEvent, { type: "tool_call_end" }>)
              .record,
          ),
        ];
      case "error":
        this.pendingError = errorText((event as { error?: unknown }).error);
        this.assistant.error = this.pendingError;
        return leading;
      case "run_end":
        return [
          ...leading,
          ...this.finishRun(
            (event as { status?: string }).status ?? "error",
            (event as { error?: unknown }).error,
          ),
        ];
      default:
        return leading;
    }
  }

  approvalRequested(step: ProcessStep, payload: unknown): AgentEventEnvelope {
    this.assistant.steps.push(step);
    return this.envelope("approval.requested", payload, this.currentTurn);
  }

  approvalResolved(approvalId: string, decision: string): AgentEventEnvelope {
    const step = this.assistant.steps.find(
      (entry) => entry.approvalId === approvalId,
    );
    if (step) {
      step.status = decision === "deny" ? "denied" : "success";
      step.completedAt = new Date().toISOString();
      if (step.startedAt)
        step.durationMs = Date.now() - Date.parse(step.startedAt);
    }
    return this.envelope(
      "approval.resolved",
      { approvalId, decision },
      this.currentTurn,
    );
  }

  evolutionProposal(payload: unknown): AgentEventEnvelope {
    return this.envelope("evolution.proposal", payload);
  }

  private appendThinking(delta: string): AgentEventEnvelope[] {
    if (!delta || !this.phase) return [];
    this.phase.thinking += delta;
    this.phase.step.content = (this.phase.step.content ?? "") + delta;
    return [
      this.envelope(
        "reasoning.delta",
        { stepId: this.phase.step.id, delta },
        this.phase.turn,
      ),
    ];
  }

  private finishPhase(message: ModelMessage): AgentEventEnvelope[] {
    const phase = this.phase;
    if (!phase) return [];
    const events: AgentEventEnvelope[] = [];
    const toolCalls = message.toolCalls ?? [];
    const text = phase.text || messageText(message);
    const thinking = messageThinking(message);
    if (thinking && !phase.thinking)
      events.push(...this.appendThinking(thinking));

    phase.step.completedAt = new Date().toISOString();
    phase.step.durationMs = phase.step.startedAt
      ? Date.now() - Date.parse(phase.step.startedAt)
      : undefined;
    phase.step.status = "success";

    if (toolCalls.length > 0) {
      if (text) {
        const separator = phase.step.content ? "\n\n" : "";
        phase.step.content = `${phase.step.content ?? ""}${separator}${text}`;
        events.push(
          this.envelope(
            "reasoning.delta",
            { stepId: phase.step.id, delta: `${separator}${text}` },
            phase.turn,
          ),
        );
      }
      this.assistant.draftAnswer = "";
      events.push(
        this.envelope(
          "answer.delta",
          {
            delta: "",
            reset: true,
            provisional: true,
            phaseId: phase.step.id,
          },
          phase.turn,
        ),
      );
    } else {
      if (!phase.step.content) {
        const index = this.assistant.steps.indexOf(phase.step);
        if (index >= 0) this.assistant.steps.splice(index, 1);
      }
      this.assistant.finalAnswer = text;
      this.assistant.draftAnswer = "";
      this.finalEmitted = Boolean(text.trim());
      if (this.finalEmitted) {
        events.push(
          this.envelope(
            "assistant.completed",
            {
              finalAnswer: text,
              usage: this.assistant.usage,
            },
            phase.turn,
          ),
        );
      }
    }
    this.phase = undefined;
    return events;
  }

  private startTool(
    call: Extract<AgentStreamEvent, { type: "tool_call_start" }>["call"],
  ): AgentEventEnvelope[] {
    const step: ProcessStep = {
      id: randomUUID(),
      type: call.name === "task" ? "subagent" : "tool",
      title:
        call.name === "task" && typeof call.arguments.description === "string"
          ? call.arguments.description
          : call.name,
      toolName: call.name,
      toolCallId: call.id,
      input: call.arguments,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.assistant.steps.push(step);
    return [
      this.envelope(
        "tool.started",
        { step: structuredClone(step) },
        this.currentTurn,
      ),
    ];
  }

  private finishTool(
    record: Extract<AgentStreamEvent, { type: "tool_call_end" }>["record"],
  ): AgentEventEnvelope[] {
    const step = this.assistant.steps.find(
      (entry) => entry.toolCallId === record.id,
    );
    if (!step) return [];
    step.status = toolStepStatus(record.status);
    step.output = jsonSafe(record.output);
    step.content = record.error;
    step.durationMs = record.durationMs;
    step.completedAt = new Date().toISOString();
    return [
      this.envelope(
        "tool.completed",
        { step: structuredClone(step) },
        this.currentTurn,
      ),
    ];
  }

  private finishRun(status: string, rawError: unknown): AgentEventEnvelope[] {
    const now = new Date().toISOString();
    this.assistant.completedAt = now;
    const error = rawError ? errorText(rawError) : this.pendingError;
    const settleIncompleteSteps = (
      settledStatus: ProcessStep["status"],
    ): void => {
      for (const step of this.assistant.steps) {
        if (step.status !== "running" && step.status !== "pending") continue;
        step.status = settledStatus;
        step.completedAt = now;
        if (step.startedAt)
          step.durationMs = Date.now() - Date.parse(step.startedAt);
      }
    };
    if (status === "user-cancelled") {
      settleIncompleteSteps("cancelled");
      this.assistant.status = "cancelled";
      if (!this.assistant.processUserOverride)
        this.assistant.processDisclosure = "expanded";
      return [this.envelope("run.cancelled", { status: "cancelled" })];
    }
    if (status === "error" || error) {
      settleIncompleteSteps("error");
      this.assistant.status = "error";
      this.assistant.error = error || "Agent run failed";
      if (!this.assistant.processUserOverride)
        this.assistant.processDisclosure = "expanded";
      return [
        this.envelope("run.failed", {
          status: "error",
          error: this.assistant.error,
        }),
      ];
    }
    if (!this.finalEmitted) {
      settleIncompleteSteps("error");
      this.assistant.status = "error";
      this.assistant.error =
        "The run ended before the model produced a final answer.";
      if (!this.assistant.processUserOverride)
        this.assistant.processDisclosure = "expanded";
      return [
        this.envelope("run.failed", {
          status: "error",
          error: this.assistant.error,
        }),
      ];
    }
    this.assistant.status = "completed";
    if (!this.assistant.processUserOverride) {
      const needsAttention = this.assistant.steps.some(
        (step) =>
          step.status === "denied" ||
          step.status === "error" ||
          step.status === "cancelled",
      );
      this.assistant.processDisclosure = needsAttention
        ? "expanded"
        : "collapsed";
    }
    return [this.envelope("run.completed", { status: "completed" })];
  }

  private addUsage(usage: TokenUsage): void {
    const current = this.assistant.usage ?? {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    current.promptTokens += usage.promptTokens;
    current.completionTokens += usage.completionTokens;
    current.totalTokens += usage.totalTokens;
    this.assistant.usage = current;
  }

  private envelope<T>(
    type: AgentEventEnvelope<T>["type"],
    payload: T,
    turn?: number,
  ): AgentEventEnvelope<T> {
    return {
      version: 1,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      ...this.identity,
      turn,
      type,
      payload,
    };
  }
}
