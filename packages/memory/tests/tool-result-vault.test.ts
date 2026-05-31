import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ToolResultVault, tryDecodeEviction } from "../src/tool-result-vault.js";

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "walle-vault-"));
}

describe("ToolResultVault", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tmp();
  });

  it("shouldEvict respects threshold", () => {
    const vault = new ToolResultVault({ dir, thresholdChars: 10 });
    expect(vault.shouldEvict("short")).toBe(false);
    expect(vault.shouldEvict("this is way longer than 10 chars")).toBe(true);
  });

  it("buildPreview returns full content when short enough", () => {
    const vault = new ToolResultVault({
      dir,
      previewHeadLines: 2,
      previewTailLines: 2,
    });
    const content = "a\nb\nc";
    expect(vault.buildPreview(content)).toBe(content);
  });

  it("buildPreview returns head + marker + tail for long content", () => {
    const vault = new ToolResultVault({
      dir,
      previewHeadLines: 2,
      previewTailLines: 2,
    });
    const lines = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const preview = vault.buildPreview(lines.join("\n"));
    expect(preview).toContain("... [4 lines truncated] ...");
    expect(preview.startsWith("a\nb")).toBe(true);
    expect(preview.endsWith("g\nh")).toBe(true);
  });

  it("evict writes .txt + .meta.json and returns a decodable envelope", async () => {
    const vault = new ToolResultVault({
      dir,
      thresholdChars: 5,
      previewHeadLines: 1,
      previewTailLines: 1,
    });
    const envelope = await vault.evict({
      toolCallId: "tc-1",
      toolName: "big_op",
      content: "line1\nline2\nline3\nline4",
    });

    expect(envelope.size).toBe("line1\nline2\nline3\nline4".length);
    expect(envelope.path.endsWith("tc-1.txt")).toBe(true);

    const txt = await fs.readFile(path.join(dir, "tc-1.txt"), "utf-8");
    expect(txt).toBe("line1\nline2\nline3\nline4");

    const meta = JSON.parse(await fs.readFile(path.join(dir, "tc-1.meta.json"), "utf-8"));
    expect(meta.toolCallId).toBe("tc-1");
    expect(meta.size).toBe(envelope.size);

    const full = await vault.readFull("tc-1");
    expect(full).toBe("line1\nline2\nline3\nline4");
  });

  it("formatSummary includes path + preview + canonical header", () => {
    const vault = new ToolResultVault({ dir });
    const summary = vault.formatSummary({
      _kind: "walle.evicted-tool-result",
      toolCallId: "abc",
      toolName: "t",
      path: "/tmp/evicted/abc.txt",
      size: 10000,
      preview: "head\n... [N lines truncated] ...\ntail",
      evictedAt: "2026-05-05T00:00:00.000Z",
    });
    expect(summary.startsWith("Tool result too long.")).toBe(true);
    expect(summary).toContain("/tmp/evicted/abc.txt");
    expect(summary).toContain("toolCallId=abc");
    expect(summary).toContain("head\n... [N lines truncated] ...\ntail");
  });

  it("tryDecodeEviction roundtrips", () => {
    const envelope = {
      _kind: "walle.evicted-tool-result",
      toolCallId: "x",
      toolName: "t",
      path: "/p",
      size: 1,
      preview: "p",
      evictedAt: "now",
    } as const;
    const s = JSON.stringify(envelope);
    expect(tryDecodeEviction(s)?.toolCallId).toBe("x");
    expect(tryDecodeEviction("not json")).toBeUndefined();
    expect(tryDecodeEviction(JSON.stringify({ other: 1 }))).toBeUndefined();
  });

  it("sanitizes tool call ids before using them as filenames", async () => {
    const vault = new ToolResultVault({ dir, thresholdChars: 1 });
    const envelope = await vault.evict({
      toolCallId: "weird/../id",
      toolName: "t",
      content: "aaaa",
    });
    // File written inside dir, not traversing out
    expect(envelope.path.startsWith(dir)).toBe(true);
    expect(envelope.path).not.toContain("..");
  });
});
