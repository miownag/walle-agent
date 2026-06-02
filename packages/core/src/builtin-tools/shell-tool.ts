/**
 * Built-in shell/bash tool: execute shell commands
 */

import { execSync } from "child_process";
import { z } from "zod";
import { defineTool } from "../tool.js";

/**
 * bash — Run shell commands
 */
export const bashTool = defineTool(
  "bash",
  "Execute bash shell commands. Use with caution and avoid running untrusted code.",
  {
    command: z.string().describe("The shell command to execute."),
    cwd: z
      .string()
      .optional()
      .describe("Working directory for the command. Defaults to current directory."),
    timeout: z
      .number()
      .optional()
      .describe("Maximum execution time in milliseconds. Default is 30000 (30 seconds)."),
  },
  async (input) => {
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
        const error = execError as {
          status?: number;
          stdout?: Buffer;
          stderr?: Buffer;
          message?: string;
        };
        return {
          status: "error",
          command: input.command,
          exitCode: error.status || 1,
          stdout: error.stdout ? error.stdout.toString() : "",
          stderr: error.stderr
            ? error.stderr.toString()
            : error.message || "Unknown error",
        };
      }
    } catch (error) {
      return { error: String(error) };
    }
  },
  {
    riskLevel: "high",
    requiresApproval: true,
    tags: ["builtin", "shell"],
    annotations: {
      title: "Run shell command",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
  },
);
