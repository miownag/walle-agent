/**
 * Token estimation utilities — shared by TokenBudget and the macro
 * compression auto-trigger.
 *
 * The estimator is intentionally simple (no provider round-trip): English
 * text is approximated at 4 chars / token and CJK at ~1.5 chars / token.
 * Empirically accurate to within ~10% for mixed prose, which is fine for
 * the budget gates.
 */

import type { ModelMessage } from "./message.js";

const CJK_CHARS_PER_TOKEN = 1.5;
const OTHER_CHARS_PER_TOKEN = 4;

/** Fixed overhead added per ModelMessage to account for role + structural tokens. */
const MESSAGE_OVERHEAD_TOKENS = 3;

/**
 * Estimate tokens for a single string.
 *
 * Heuristic: split chars into CJK block (`U+4E00..U+9FFF`) vs. the rest.
 */
export function estimateStringTokens(content: string): number {
  if (!content) return 0;
  let cjk = 0;
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (code >= 0x4e00 && code <= 0x9fff) cjk++;
  }
  const other = content.length - cjk;
  return Math.ceil(cjk / CJK_CHARS_PER_TOKEN + other / OTHER_CHARS_PER_TOKEN);
}

/**
 * Estimate tokens for content blocks or a plain string.
 */
function estimateContentTokens(
  content: ModelMessage["content"],
): number {
  if (!content) return 0;
  if (typeof content === "string") return estimateStringTokens(content);
  let total = 0;
  for (const block of content) {
    switch (block.type) {
      case "text":
        total += estimateStringTokens(block.text);
        break;
      case "tool_use":
        total +=
          estimateStringTokens(block.name) +
          estimateStringTokens(JSON.stringify(block.input ?? {}));
        break;
      case "tool_result":
        if (typeof block.content === "string") {
          total += estimateStringTokens(block.content);
        } else if (Array.isArray(block.content)) {
          for (const inner of block.content) {
            if (inner.type === "text") total += estimateStringTokens(inner.text);
          }
        }
        break;
      case "thinking":
        total += estimateStringTokens(block.thinking);
        break;
      // image: charge a small constant; no character data to count.
      case "image":
        total += 200;
        break;
    }
  }
  return total;
}

/**
 * Estimate tokens for a string OR a list of ModelMessages.
 *
 * For messages, we add a small structural overhead per message in addition
 * to the content estimate, plus a tool-call surcharge for assistant turns
 * that triggered tool calls.
 */
export function estimateTokens(input: string | ModelMessage[]): number {
  if (typeof input === "string") return estimateStringTokens(input);
  let total = 0;
  for (const msg of input) {
    total += MESSAGE_OVERHEAD_TOKENS;
    total += estimateContentTokens(msg.content);
    if (msg.toolCalls) {
      for (const call of msg.toolCalls) {
        total +=
          estimateStringTokens(call.name) +
          estimateStringTokens(JSON.stringify(call.arguments ?? {}));
      }
    }
  }
  return total;
}
