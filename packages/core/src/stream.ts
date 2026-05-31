/**
 * AgentStream — wraps AsyncGenerator with helper methods.
 * AgentStreamEvent types.
 */

import type { ModelMessage, ModelToolCall } from "./message.js";
import type { ToolCallRecord } from "./tool.js";
import type { AgentInput, AgentResult } from "./agent-config.js";
import type { LLMStreamChunk } from "./llm-provider.js";
import type { RunStatus } from "./events.js";

// ─── Stream Event Types ────────────────────────────────────────────

export interface RunStartEvent {
  type: "run_start";
  input: AgentInput;
  /** Unique id for this run; used by memory/session plugins to correlate messages. */
  runId: string;
  /** Session id (if provided via AgentInput/RunOptions). */
  sessionId?: string;
}

export interface RunEndEvent {
  type: "run_end";
  runId: string;
  sessionId?: string;
  status: RunStatus;
  error?: unknown;
}

export interface ModelCallStartEvent {
  type: "model_call_start";
  turn: number;
}

export interface ModelCallEndEvent {
  type: "model_call_end";
  message: ModelMessage;
}

export interface TextDeltaEvent {
  type: "text_delta";
  content: string;
}

export interface ToolCallDeltaEvent {
  type: "tool_call_delta";
  toolCallId: string;
  name?: string;
  argumentsDelta?: string;
}

export interface ToolCallStartEvent {
  type: "tool_call_start";
  call: ModelToolCall;
}

export interface ToolCallEndEvent {
  type: "tool_call_end";
  record: ToolCallRecord;
}

export interface LLMChunkEvent {
  type: "llm_chunk";
  chunk: LLMStreamChunk;
}

export interface ErrorEvent {
  type: "error";
  error: Error;
}

export type AgentStreamEvent =
  | RunStartEvent
  | RunEndEvent
  | ModelCallStartEvent
  | ModelCallEndEvent
  | TextDeltaEvent
  | ToolCallDeltaEvent
  | ToolCallStartEvent
  | ToolCallEndEvent
  | LLMChunkEvent
  | ErrorEvent;

// ─── AgentStream ───────────────────────────────────────────────────

export class AgentStream implements AsyncIterable<AgentStreamEvent> {
  private generator: AsyncGenerator<AgentStreamEvent>;

  constructor(generator: AsyncGenerator<AgentStreamEvent>) {
    this.generator = generator;
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentStreamEvent> {
    return this.generator;
  }

  /**
   * Collect all events and return final AgentResult.
   */
  async collect(): Promise<AgentResult> {
    const events: AgentStreamEvent[] = [];
    let content = "";
    const toolCalls: ToolCallRecord[] = [];
    const messages: ModelMessage[] = [];

    for await (const event of this.generator) {
      events.push(event);

      if (event.type === "text_delta") {
        content += event.content;
      }

      if (event.type === "tool_call_end") {
        toolCalls.push(event.record);
      }

      if (event.type === "model_call_end") {
        messages.push(event.message);
      }
    }

    return { content, messages, toolCalls, events };
  }

  /**
   * Only yield text content (convenience for UI rendering).
   */
  async *text(): AsyncGenerator<string> {
    for await (const event of this.generator) {
      if (event.type === "text_delta") {
        yield event.content;
      }
    }
  }

  /**
   * Transform stream events (map/filter).
   */
  pipe<T>(transform: (event: AgentStreamEvent) => T | null): AsyncGenerator<T> {
    const gen = this.generator;
    return (async function* () {
      for await (const event of gen) {
        const result = transform(event);
        if (result !== null) yield result;
      }
    })();
  }
}
