/**
 * PromptBuilder — assembles the final message list for LLM calls.
 */

import type { ModelMessage } from "./message.js";
import type { AgentInput } from "./agent-config.js";
import type { ContextItem } from "./events.js";
import type { Tool } from "./tool.js";

export interface PromptBuildOptions {
  systemPrompt?: string;
  input: AgentInput;
  context: ContextItem[];
  tools: Tool[];
  conversationHistory?: ModelMessage[];
}

export class PromptBuilder {
  /**
   * Build the message list for an LLM call.
   */
  build(options: PromptBuildOptions): ModelMessage[] {
    const messages: ModelMessage[] = [];

    // 1. System message
    const systemParts: string[] = [];
    if (options.systemPrompt) {
      systemParts.push(options.systemPrompt);
    }

    // Inject context items into system prompt
    if (options.context.length > 0) {
      const contextSection = options.context
        .map((item) => `[${item.source}]\n${item.content}`)
        .join("\n\n");
      systemParts.push(`\n<context>\n${contextSection}\n</context>`);
    }

    if (systemParts.length > 0) {
      messages.push({
        role: "system",
        content: systemParts.join("\n"),
      });
    }

    // 2. Conversation history
    if (options.conversationHistory) {
      messages.push(...options.conversationHistory);
    }

    // 3. User input
    const userContent = typeof options.input.content === "string"
      ? options.input.content
      : options.input.content;

    messages.push({
      role: "user",
      content: userContent,
    });

    return messages;
  }
}
