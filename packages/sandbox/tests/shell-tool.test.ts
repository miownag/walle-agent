import { describe, it, expect, vi } from "vitest";
import { buildShellTool } from "../src/shell-tool.js";
import type {
  Sandbox,
  SandboxCommand,
  SandboxResult,
} from "../src/sandbox-types.js";

function fakeSandbox(): { sandbox: Sandbox; calls: SandboxCommand[] } {
  const calls: SandboxCommand[] = [];
  const sandbox: Sandbox = {
    name: "fake",
    async run(cmd) {
      calls.push(cmd);
      return {
        stdout: "ok",
        stderr: "",
        exitCode: 0,
        durationMs: 1,
      } satisfies SandboxResult;
    },
  };
  return { sandbox, calls };
}

describe("buildShellTool", () => {
  it("registers correct tool metadata for permissions gating", () => {
    const { sandbox } = fakeSandbox();
    const tool = buildShellTool(sandbox);
    expect(tool.name).toBe("shell");
    expect(tool.riskLevel).toBe("high");
    expect(tool.requiresApproval).toBe(true);
    expect(tool.tags).toEqual(["builtin", "shell"]);
    expect(tool.parameters).toMatchObject({
      type: "object",
      required: ["command"],
    });
  });

  it("calls sandbox.run with sh -c <command>", async () => {
    const { sandbox, calls } = fakeSandbox();
    const tool = buildShellTool(sandbox);
    await tool.execute(
      { command: "echo hi | grep h", cwd: "/work", timeoutMs: 2_000 },
      { agent: undefined as never },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      cmd: "sh",
      args: ["-c", "echo hi | grep h"],
      cwd: "/work",
      timeoutMs: 2_000,
    });
  });

  it("returns the SandboxResult verbatim", async () => {
    const sandbox: Sandbox = {
      name: "fake",
      async run() {
        return {
          stdout: "out",
          stderr: "err",
          exitCode: 7,
          durationMs: 42,
          timedOut: false,
        };
      },
    };
    const tool = buildShellTool(sandbox);
    const out = await tool.execute({ command: "x" }, { agent: undefined as never });
    expect(out).toEqual({
      stdout: "out",
      stderr: "err",
      exitCode: 7,
      durationMs: 42,
      timedOut: false,
    });
  });

  it("propagates sandbox throws", async () => {
    const sandbox: Sandbox = {
      name: "fake",
      async run() {
        throw new Error("boom");
      },
    };
    const tool = buildShellTool(sandbox);
    await expect(
      tool.execute({ command: "x" }, { agent: undefined as never }),
    ).rejects.toThrow(/boom/);
  });
});
