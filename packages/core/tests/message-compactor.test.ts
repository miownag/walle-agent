/**
 * Tests for `partitionByTurns`, `buildPlaceholder`, `isPlaceholder`.
 */

import { describe, it, expect } from "vitest";
import {
  partitionByTurns,
  buildPlaceholder,
  isPlaceholder,
  TOOL_RESULT_PLACEHOLDER_PREFIX,
} from "../src/message-compactor.js";
import type { ModelMessage } from "../src/index.js";

const sys = (text: string): ModelMessage => ({ role: "system", content: text });
const user = (text: string): ModelMessage => ({ role: "user", content: text });
const asst = (text: string, toolCalls?: ModelMessage["toolCalls"]): ModelMessage => ({
  role: "assistant",
  content: text,
  toolCalls,
});
const tool = (id: string, content: string): ModelMessage => ({
  role: "tool",
  toolCallId: id,
  content,
  metadata: { toolName: "x", status: "success" },
});

describe("partitionByTurns", () => {
  it("keeps everything when no assistant turns exist", () => {
    const msgs = [sys("s"), user("u")];
    const r = partitionByTurns(msgs, 3);
    expect(r.evictableIndices.size).toBe(0);
    expect(r.keepIndices.size).toBe(2);
    expect(r.turnStarts).toEqual([]);
  });

  it("keeps everything when fewer turns than keepRecentTurns", () => {
    const msgs = [
      sys("s"),
      user("u"),
      asst("a1"),
      tool("t1", "X"),
      asst("a2"),
      tool("t2", "Y"),
    ];
    const r = partitionByTurns(msgs, 3);
    expect(r.evictableIndices.size).toBe(0);
    expect(r.keepIndices.size).toBe(6);
  });

  it("evicts older turns when there are more than keepRecentTurns", () => {
    const msgs = [
      sys("s"),         // 0
      user("u"),        // 1
      asst("a1"),       // 2  ── turn 1 (oldest)
      tool("t1", "X"),  // 3
      asst("a2"),       // 4  ── turn 2
      tool("t2", "Y"),  // 5
      asst("a3"),       // 6  ── turn 3
      tool("t3", "Z"),  // 7
      asst("a4"),       // 8  ── turn 4 (newest)
      tool("t4", "W"),  // 9
    ];
    const r = partitionByTurns(msgs, 3);
    expect(r.turnStarts).toEqual([2, 4, 6, 8]);
    // System always kept
    expect(r.keepIndices.has(0)).toBe(true);
    // user(1) is in evictable region (before oldest protected turn)
    expect(r.evictableIndices.has(1)).toBe(true);
    // turn 1 (idx 2,3) evictable
    expect(r.evictableIndices.has(2)).toBe(true);
    expect(r.evictableIndices.has(3)).toBe(true);
    // turn 2 onwards (cutoff = 4) kept
    for (let i = 4; i < 10; i++) expect(r.keepIndices.has(i)).toBe(true);
  });

  it("treats keepRecentTurns <= 0 as 'evict everything non-system'", () => {
    const msgs = [sys("s"), user("u"), asst("a"), tool("t", "X")];
    const r = partitionByTurns(msgs, 0);
    expect(r.keepIndices.has(0)).toBe(true); // system
    expect(r.evictableIndices.has(1)).toBe(true);
    expect(r.evictableIndices.has(2)).toBe(true);
    expect(r.evictableIndices.has(3)).toBe(true);
  });
});

describe("buildPlaceholder", () => {
  it("contains all metadata fields and the read_tool_result hint", () => {
    const out = buildPlaceholder({
      idx: 5,
      toolName: "bash",
      toolCallId: "abc",
      size: 12345,
      vaultPath: "/tmp/abc.txt",
      preview: "PREVIEW",
    });
    expect(out).toContain("[ToolResult #5 evicted");
    expect(out).toContain("tool=bash");
    expect(out).toContain("toolCallId=abc");
    expect(out).toContain("size=12345 chars");
    expect(out).toContain('read_tool_result(toolCallId="abc")');
    expect(out).toContain("/tmp/abc.txt");
    expect(out).toContain("PREVIEW");
    expect(out.startsWith(TOOL_RESULT_PLACEHOLDER_PREFIX)).toBe(true);
  });

  it("omits read_file hint when no vault path is given", () => {
    const out = buildPlaceholder({
      idx: 1,
      toolName: "x",
      toolCallId: "id",
      size: 10,
      preview: "p",
    });
    expect(out).not.toContain("read_file(");
    expect(out).toContain('read_tool_result(toolCallId="id")');
  });
});

describe("isPlaceholder", () => {
  it("matches generated placeholders", () => {
    const p = buildPlaceholder({
      idx: 1,
      toolName: "x",
      toolCallId: "id",
      size: 1,
      preview: "p",
    });
    expect(isPlaceholder(p)).toBe(true);
  });

  it("does not match plain content", () => {
    expect(isPlaceholder("hello")).toBe(false);
    expect(isPlaceholder(null)).toBe(false);
    expect(isPlaceholder(undefined)).toBe(false);
    expect(isPlaceholder(42)).toBe(false);
  });
});
