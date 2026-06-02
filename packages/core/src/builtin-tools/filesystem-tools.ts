/**
 * Built-in filesystem tools: ls, read_file, write_file, edit_file, glob, grep
 */

import { promises as fs } from "fs";
import { resolve, join } from "path";
import { globSync } from "glob";
import { z } from "zod";
import { defineTool } from "../tool.js";

/**
 * ls — List directory contents
 */
export const lsTool = defineTool(
  "ls",
  "List files and directories in a specified path. Shows file names, types, and basic metadata.",
  {
    path: z
      .string()
      .optional()
      .describe("The directory path to list. Defaults to current directory."),
    recursive: z
      .boolean()
      .optional()
      .describe("If true, recursively list all subdirectories and files."),
    detailed: z
      .boolean()
      .optional()
      .describe("If true, show detailed information including file sizes and timestamps."),
  },
  async (input) => {
    try {
      const dir = input.path ? resolve(input.path) : process.cwd();
      const entries = await fs.readdir(dir, { withFileTypes: true });

      const results = [];
      for (const entry of entries) {
        const name = entry.name;
        const type = entry.isDirectory()
          ? "dir"
          : entry.isSymbolicLink()
            ? "link"
            : "file";

        const item: Record<string, unknown> = { name, type };

        if (input.detailed) {
          try {
            const fullPath = join(dir, name);
            const stats = await fs.stat(fullPath);
            item.size = stats.size;
            item.modified = stats.mtime.toISOString();
          } catch {
            // Skip if stat fails
          }
        }
        results.push(item);
      }

      if (input.recursive) {
        const recursiveResults: Array<{ path: string; type: string }> = [];
        const processDir = async (currentPath: string, prefix = "") => {
          const dirEntries = await fs.readdir(currentPath, { withFileTypes: true });
          for (const entry of dirEntries) {
            const name = entry.name;
            const fullPath = join(currentPath, name);
            const type = entry.isDirectory() ? "dir" : "file";
            recursiveResults.push({ path: prefix + name, type });

            if (entry.isDirectory()) {
              await processDir(fullPath, prefix + name + "/");
            }
          }
        };
        await processDir(dir);
        return {
          path: dir,
          entries: results.length,
          recursiveEntries: recursiveResults,
        };
      }

      return { path: dir, entries: results };
    } catch (error) {
      return { error: String(error) };
    }
  },
  {
    riskLevel: "low",
    tags: ["builtin", "filesystem"],
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
);

/**
 * read_file — Read file contents
 */
export const readFileTool = defineTool(
  "read_file",
  "Read the contents of a file. Supports pagination for large files to prevent context overflow.",
  {
    path: z.string().describe("The file path to read."),
    startLine: z
      .number()
      .optional()
      .describe("Starting line number (1-indexed). Default is 1."),
    endLine: z
      .number()
      .optional()
      .describe("Ending line number (1-indexed). If omitted, reads to end of file."),
  },
  async (input) => {
    try {
      const filePath = resolve(input.path);
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content.split("\n");

      const startLine = Math.max(1, input.startLine || 1);
      const endLine = Math.min(lines.length, input.endLine || lines.length);

      const selectedLines = lines.slice(startLine - 1, endLine);
      const result = selectedLines.join("\n");

      return {
        path: filePath,
        content: result,
        totalLines: lines.length,
        readLines: { start: startLine, end: endLine },
      };
    } catch (error) {
      return { error: String(error) };
    }
  },
  {
    riskLevel: "low",
    tags: ["builtin", "filesystem"],
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
);

/**
 * write_file — Write or overwrite a file
 */
export const writeFileTool = defineTool(
  "write_file",
  "Write content to a file. Creates the file if it doesn't exist, or overwrites it if it does. Creates parent directories automatically.",
  {
    path: z.string().describe("The file path to write to."),
    content: z.string().describe("The content to write to the file."),
  },
  async (input) => {
    try {
      const filePath = resolve(input.path);
      // Ensure parent directory exists
      const dir = filePath.substring(0, filePath.lastIndexOf("/"));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, input.content, "utf-8");
      return {
        path: filePath,
        status: "success",
        bytesWritten: input.content.length,
      };
    } catch (error) {
      return { error: String(error) };
    }
  },
  {
    riskLevel: "medium",
    requiresApproval: true,
    tags: ["builtin", "filesystem", "file-write"],
    annotations: { destructiveHint: true, openWorldHint: false },
  },
);

/**
 * edit_file — Edit specific content in a file
 */
export const editFileTool = defineTool(
  "edit_file",
  "Edit file contents by replacing exact string matches. Read the file first to get the exact content.",
  {
    path: z.string().describe("The file path to edit."),
    search: z.string().describe("The exact text to search for and replace."),
    replace: z.string().describe("The text to replace with."),
    global: z
      .boolean()
      .optional()
      .describe(
        "If true, replace all occurrences. If false, replace only the first. Default is true.",
      ),
  },
  async (input) => {
    try {
      const filePath = resolve(input.path);
      const content = await fs.readFile(filePath, "utf-8");

      const globalFlag = input.global !== false;
      const regex = new RegExp(
        input.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        globalFlag ? "g" : undefined,
      );

      const newContent = content.replace(regex, input.replace);

      if (newContent === content) {
        return { error: "Search text not found in file" };
      }

      await fs.writeFile(filePath, newContent, "utf-8");
      return {
        path: filePath,
        status: "success",
      };
    } catch (error) {
      return { error: String(error) };
    }
  },
  {
    riskLevel: "medium",
    requiresApproval: true,
    tags: ["builtin", "filesystem", "file-write"],
    annotations: { destructiveHint: true, openWorldHint: false },
  },
);

/**
 * glob — Find files matching patterns
 */
export const globTool = defineTool(
  "glob",
  "Find files matching a glob pattern. Uses standard glob syntax with * for any characters and ** for recursive matching.",
  {
    pattern: z
      .string()
      .describe("Glob pattern to match files. E.g., '*.ts', 'src/**/*.test.ts'"),
    cwd: z
      .string()
      .optional()
      .describe("Working directory for the glob search. Defaults to current directory."),
  },
  async (input) => {
    try {
      const workDir = input.cwd ? resolve(input.cwd) : process.cwd();
      const files = globSync(input.pattern, { cwd: workDir });

      return {
        pattern: input.pattern,
        cwd: workDir,
        matches: files,
        count: files.length,
      };
    } catch (error) {
      return { error: String(error) };
    }
  },
  {
    riskLevel: "low",
    tags: ["builtin", "filesystem"],
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
);

/**
 * grep — Search for text patterns in files
 */
export const grepTool = defineTool(
  "grep",
  "Search for text patterns in files. Can search a single file or multiple files matching a glob pattern.",
  {
    pattern: z.string().describe("Text or regex pattern to search for."),
    file: z.string().describe("Single file path or glob pattern to search in."),
    ignoreCase: z
      .boolean()
      .optional()
      .describe("If true, search is case-insensitive."),
    regex: z
      .boolean()
      .optional()
      .describe(
        "If true, treat pattern as regular expression. Default is false (literal string).",
      ),
  },
  async (input) => {
    try {
      const files = globSync(input.file);

      if (files.length === 0) {
        return { error: `No files matched pattern: ${input.file}` };
      }

      const results: Array<{
        file: string;
        lines: Array<{ lineNumber: number; content: string }>;
      }> = [];

      for (const filePath of files) {
        try {
          const fullPath = resolve(filePath);
          const content = await fs.readFile(fullPath, "utf-8");
          const fileLines = content.split("\n");

          const flags = input.ignoreCase ? "i" : "";
          const searchRegex = input.regex
            ? new RegExp(input.pattern, flags)
            : new RegExp(
                input.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
                flags,
              );

          const matches = [];
          for (let i = 0; i < fileLines.length; i++) {
            if (searchRegex.test(fileLines[i])) {
              matches.push({ lineNumber: i + 1, content: fileLines[i] });
            }
          }

          if (matches.length > 0) {
            results.push({ file: filePath, lines: matches });
          }
        } catch {
          // Skip files that can't be read
        }
      }

      return {
        pattern: input.pattern,
        filesSearched: files.length,
        filesMatched: results.length,
        results,
      };
    } catch (error) {
      return { error: String(error) };
    }
  },
  {
    riskLevel: "low",
    tags: ["builtin", "filesystem"],
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
);
