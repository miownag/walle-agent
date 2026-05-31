/**
 * Built-in shell/bash tool: execute shell commands
 */

import { execSync } from "child_process";
import { defineTool } from "../tool.js";

/**
 * bash — Run shell commands
 */
export const bashTool = defineTool({
  name: "bash",
  description: "Execute bash shell commands. Use with caution and avoid running untrusted code.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute.",
      },
      cwd: {
        type: "string",
        description: "Working directory for the command. Defaults to current directory.",
      },
      timeout: {
        type: "number",
        description: "Maximum execution time in milliseconds. Default is 30000 (30 seconds).",
      },
    },
    required: ["command"],
  },
  riskLevel: "high",
  requiresApproval: true,
  tags: ["builtin", "shell"],
  async execute(input: { command: string; cwd?: string; timeout?: number }) {
    try {
      const timeoutMs = input.timeout || 30000;
      const options = {
        cwd: input.cwd || process.cwd(),
        encoding: "utf-8" as const,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      };

      try {
        const output = execSync(input.command, options);
        return {
          status: "success",
          command: input.command,
          output: output.toString(),
          exitCode: 0,
        };
      } catch (execError: unknown) {
        const error = execError as { status?: number; stdout?: Buffer; stderr?: Buffer; message?: string };
        return {
          status: "error",
          command: input.command,
          exitCode: error.status || 1,
          stdout: error.stdout ? error.stdout.toString() : "",
          stderr: error.stderr ? error.stderr.toString() : error.message || "Unknown error",
        };
      }
    } catch (error) {
      return { error: String(error) };
    }
  },
});
