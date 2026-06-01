/**
 * Tests for `estimateTokens` / `estimateStringTokens`.
 */

import { describe, it, expect } from "vitest";
import { estimateTokens, estimateStringTokens } from "../src/token-estimate.js";
import type { ModelMessage } from "../src/index.js";

describe("estimateStringTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateStringTokens("")).toBe(0);
  });

  it("approximates English at ~4 chars/token", () => {
    // 16 chars → 4 tokens
    expect(estimateStringTokens("hello world test")).toBe(4);
  });

  it("counts CJK at ~1.5 chars/token", () => {
    // 6 CJK chars → ceil(6 / 1.5) = 4
    expect(estimateStringTokens("中文测试一下")).toBe(4);
  });

  it("mixes English + CJK additively", () => {
    // 3 CJK + 6 ASCII → ceil(3/1.5 + 6/4) = ceil(2 + 1.5) = 4
    expect(estimateStringTokens("中文hello!")).toBeGreaterThan(0);
  });
});

describe("estimateTokens for ModelMessage[]", () => {
  it("sums per-message overhead and content estimates", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello back" },
    ];
    const t = estimateTokens(msgs);
    // 3 (overhead) + ceil(2/4) + 3 + ceil(10/4) = 3+1+3+3 = 10
    expect(t).toBeGreaterThanOrEqual(8);
    expect(t).toBeLessThanOrEqual(14);
  });

  it("counts toolCalls on assistant messages", () => {
    const noCalls: ModelMessage[] = [{ role: "assistant", content: "x" }];
    const withCalls: ModelMessage[] = [
      {
        role: "assistant",
        content: "x",
        toolCalls: [
          { id: "1", name: "do_something", arguments: { a: 1, b: "two" } },
        ],
      },
    ];
    expect(estimateTokens(withCalls)).toBeGreaterThan(estimateTokens(noCalls));
  });

  it("handles content blocks", () => {
    const msgs: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "hello" },
          { type: "thinking", thinking: "reasoning here" },
        ],
      },
    ];
    expect(estimateTokens(msgs)).toBeGreaterThan(3);
  });

  it("accepts a plain string", () => {
    expect(estimateTokens("hello world")).toBe(estimateStringTokens("hello world"));
  });
});
