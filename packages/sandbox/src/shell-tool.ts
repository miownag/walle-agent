/**
 * `shell` tool — exposes a Sandbox to the LLM as a high-risk shell tool.
 *
 * Wraps the user-supplied command string with `sh -c "..."` so quoting,
 * pipes, and redirects work as expected. The naive `cmd.split(/\s+/)`
 * approach in the spec would drop quoting; we deviate intentionally.
 *
 * The same tag/risk profile as the built-in `bashTool` so the Permissions
 * slice (`requireApprovalFor.shell` / `mode: "deny-high-risk"`) gates it
 * automatically.
 */

import { z } from "zod";
import { defineTool, type Tool } from "@walle-agent/core";
import type { Sandbox, SandboxResult } from "./sandbox-types.js";

export interface ShellToolInput {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export function buildShellTool(sandbox: Sandbox): Tool<ShellToolInput, SandboxResult> {
  return defineTool(
    "shell",
    "Execute a shell command in a sandboxed environment. Use for system-level operations that need isolation. Returns stdout/stderr/exitCode/durationMs (and timedOut if the command was killed for exceeding the timeout).",
    {
      command: z
        .string()
        .describe(
          "Shell command line; runs under `sh -c`, so quoting/pipes/redirects work as usual.",
        ),
      cwd: z
        .string()
        .optional()
        .describe("Working directory. Falls back to the sandbox's default cwd."),
      timeoutMs: z
        .number()
        .optional()
        .describe(
          "Per-call timeout override. Falls back to the sandbox's default (30s for local, 60s for docker).",
        ),
    },
    async (input) => {
      return sandbox.run({
        cmd: "sh",
        args: ["-c", input.command],
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
      });
    },
    {
      riskLevel: "high",
      requiresApproval: true,
      tags: ["builtin", "shell"],
      annotations: {
        title: "Run sandboxed shell command",
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
  );
}
