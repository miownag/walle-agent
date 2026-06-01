/**
 * Conversation summarizer — pure helpers for macro context compression.
 *
 * Given a list of `ModelMessage`s (typically the "head" region produced by
 * `partitionByTurns`), render a single textual summary suitable for replacing
 * those messages in-place. The actual replacement is done by `AgentRuntime`
 * (which keeps system messages and the protected tail intact).
 */

import type { LLMProvider } from "./llm-provider.js";
import type { ModelMessage } from "./message.js";

/**
 * Default summary prompt. The single placeholder `{{messages}}` is replaced
 * with a rendered version of the conversation slice. Override via
 * `MacroCompressionConfig.summaryPrompt`.
 */
export const DEFAULT_SUMMARY_PROMPT = `\
You are summarising a conversation between a user and an AI agent so the agent \
can continue with limited context. Preserve:
1. The user's overall goal and constraints
2. Key facts/decisions made
3. Outstanding tasks or pending questions
4. Any tool call ids / file paths the agent may need to reference later
5. Errors or warnings the agent should remember

Output: a markdown bulleted summary, ≤ 800 tokens. Do not invent facts.

<conversation>
{{messages}}
</conversation>`;

/**
 * Sentinel prefix on the synthesised user message that replaces the
 * compressed region. Detection of this prefix is how repeat compactions are
 * idempotent (we replace the existing summary message rather than stack one).
 */
export const SUMMARY_MESSAGE_PREFIX = "[Summary of ";

export interface SummariseInput {
  /** LLM used to generate the summary. Usually the agent's own model. */
  model: LLMProvider;
  /** The slice to compress — typically the head region. */
  messages: ModelMessage[];
  /** Optional override of the prompt; must contain `{{messages}}`. */
  promptTemplate?: string;
  signal?: AbortSignal;
}

/**
 * Render messages as plain text for embedding into the summary prompt. Tool
 * calls / tool results are flattened to readable lines. Long content is
 * truncated to 500 chars with a `[truncated]` marker so we don't blow past
 * the summary model's window.
 */
export function renderMessagesForSummary(messages: ModelMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const role = msg.role.toUpperCase();
    if (msg.role === "tool") {
      const id = msg.toolCallId ?? "?";
      lines.push(`[TOOL_RESULT toolCallId=${id}]`);
      lines.push(truncate(stringifyContent(msg.content), 500));
      continue;
    }
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      const calls = msg.toolCalls
        .map((c) => `${c.name}(${truncate(JSON.stringify(c.arguments ?? {}), 200)})`)
        .join(", ");
      lines.push(`[${role} toolCalls=${calls}]`);
    }
    const content = stringifyContent(msg.content);
    if (content) {
      lines.push(`[${role}] ${truncate(content, 500)}`);
    }
  }
  return lines.join("\n");
}

function stringifyContent(content: ModelMessage["content"]): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "tool_use":
        parts.push(`<tool_use ${block.name}>`);
        break;
      case "tool_result":
        if (typeof block.content === "string") parts.push(block.content);
        break;
      case "thinking":
        parts.push(`<thinking ${block.thinking.slice(0, 80)}>`);
        break;
      case "image":
        parts.push("<image>");
        break;
    }
  }
  return parts.join(" ");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)} … [truncated, ${s.length - max} more chars]`;
}

/**
 * Run the summarising LLM call. Returns the model's final text content.
 *
 * The function uses streaming under the hood and aggregates `text_delta`
 * chunks; when the provider emits `message_complete` we prefer that
 * payload's content. If the model never emits any text, returns an empty
 * string.
 */
export async function summariseConversation(input: SummariseInput): Promise<string> {
  const template = input.promptTemplate ?? DEFAULT_SUMMARY_PROMPT;
  if (!template.includes("{{messages}}")) {
    throw new Error("summariseConversation: promptTemplate must contain '{{messages}}'");
  }
  const rendered = renderMessagesForSummary(input.messages);
  const prompt = template.replace("{{messages}}", rendered);

  const stream = input.model.stream({
    messages: [{ role: "user", content: prompt }],
    signal: input.signal,
  });

  let buf = "";
  let finalContent: string | undefined;
  for await (const chunk of stream) {
    if (chunk.type === "text_delta") {
      buf += chunk.content;
    } else if (chunk.type === "message_complete") {
      const c = chunk.message.content;
      if (typeof c === "string") finalContent = c;
      else if (Array.isArray(c)) {
        const merged = c
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (merged) finalContent = merged;
      }
    } else if (chunk.type === "error") {
      throw chunk.error;
    }
  }
  return finalContent ?? buf;
}
