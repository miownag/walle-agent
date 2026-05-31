/**
 * Built-in filesystem tools: ls, read_file, write_file, edit_file, glob, grep
 */

import { promises as fs } from "fs";
import { resolve, join } from "path";
import { globSync } from "glob";
import { defineTool } from "../tool.js";

/**
 * ls — List directory contents
 */
export const lsTool = defineTool({
  name: "ls",
  description: "List files and directories in a specified path. Shows file names, types, and basic metadata.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "The directory path to list. Defaults to current directory.",
      },
      recursive: {
        type: "boolean",
        description: "If true, recursively list all subdirectories and files.",
      },
      detailed: {
        type: "boolean",
        description: "If true, show detailed information including file sizes and timestamps.",
      },
    },
    required: [],
  },
  riskLevel: "low",
  tags: ["builtin", "filesystem"],
  async execute(input: { path?: string; recursive?: boolean; detailed?: boolean }) {
    try {
      const dir = input.path ? resolve(input.path) : process.cwd();
      const entries = await fs.readdir(dir, { withFileTypes: true });

      const results = [];
      for (const entry of entries) {
        const name = entry.name;
        const type = entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "link" : "file";

        let item: Record<string, unknown> = { name, type };

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
        return { path: dir, entries: results.length, recursiveEntries: recursiveResults };
      }

      return { path: dir, entries: results };
    } catch (error) {
      return { error: String(error) };
    }
  },
});

/**
 * read_file — Read file contents
 */
export const readFileTool = defineTool({
  name: "read_file",
  description: "Read the contents of a file. Supports pagination for large files to prevent context overflow.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "The file path to read.",
      },
      startLine: {
        type: "number",
        description: "Starting line number (1-indexed). Default is 1.",
      },
      endLine: {
        type: "number",
        description: "Ending line number (1-indexed). If omitted, reads to end of file.",
      },
    },
    required: ["path"],
  },
  riskLevel: "low",
  tags: ["builtin", "filesystem"],
  async execute(input: { path: string; startLine?: number; endLine?: number }) {
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
});

/**
 * write_file — Write or overwrite a file
 */
export const writeFileTool = defineTool({
  name: "write_file",
  description: "Write content to a file. Creates the file if it doesn't exist, or overwrites it if it does. Creates parent directories automatically.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "The file path to write to.",
      },
      content: {
        type: "string",
        description: "The content to write to the file.",
      },
    },
    required: ["path", "content"],
  },
  riskLevel: "medium",
  requiresApproval: true,
  tags: ["builtin", "filesystem", "file-write"],
  async execute(input: { path: string; content: string }) {
    try {
      const filePath = resolve(input.path);
      // Ensure parent directory exists
      const dir = filePath.substring(0, filePath.lastIndexOf("/"));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, input.content, "utf-8");
      return { path: filePath, status: "success", bytesWritten: input.content.length };
    } catch (error) {
      return { error: String(error) };
    }
  },
});

/**
 * edit_file — Edit specific content in a file
 */
export const editFileTool = defineTool({
  name: "edit_file",
  description: "Edit file contents by replacing exact string matches. Read the file first to get the exact content.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "The file path to edit.",
      },
      search: {
        type: "string",
        description: "The exact text to search for and replace.",
      },
      replace: {
        type: "string",
        description: "The text to replace with.",
      },
      global: {
        type: "boolean",
        description: "If true, replace all occurrences. If false, replace only the first. Default is true.",
      },
    },
    required: ["path", "search", "replace"],
  },
  riskLevel: "medium",
  requiresApproval: true,
  tags: ["builtin", "filesystem", "file-write"],
  async execute(input: { path: string; search: string; replace: string; global?: boolean }) {
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
});

/**
 * glob — Find files matching patterns
 */
export const globTool = defineTool({
  name: "glob",
  description: "Find files matching a glob pattern. Uses standard glob syntax with * for any characters and ** for recursive matching.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Glob pattern to match files. E.g., '*.ts', 'src/**/*.test.ts'",
      },
      cwd: {
        type: "string",
        description: "Working directory for the glob search. Defaults to current directory.",
      },
    },
    required: ["pattern"],
  },
  riskLevel: "low",
  tags: ["builtin", "filesystem"],
  async execute(input: { pattern: string; cwd?: string }) {
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
});

/**
 * grep — Search for text patterns in files
 */
export const grepTool = defineTool({
  name: "grep",
  description: "Search for text patterns in files. Can search a single file or multiple files matching a glob pattern.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Text or regex pattern to search for.",
      },
      file: {
        type: "string",
        description: "Single file path or glob pattern to search in.",
      },
      ignoreCase: {
        type: "boolean",
        description: "If true, search is case-insensitive.",
      },
      regex: {
        type: "boolean",
        description: "If true, treat pattern as regular expression. Default is false (literal string).",
      },
    },
    required: ["pattern", "file"],
  },
  riskLevel: "low",
  tags: ["builtin", "filesystem"],
  async execute(input: { pattern: string; file: string; ignoreCase?: boolean; regex?: boolean }) {
    try {
      const files = globSync(input.file);

      if (files.length === 0) {
        return { error: `No files matched pattern: ${input.file}` };
      }

      const results: Array<{ file: string; lines: Array<{ lineNumber: number; content: string }> }> = [];

      for (const filePath of files) {
        try {
          const fullPath = resolve(filePath);
          const content = await fs.readFile(fullPath, "utf-8");
          const fileLines = content.split("\n");

          const flags = input.ignoreCase ? "i" : "";
          const searchRegex = input.regex
            ? new RegExp(input.pattern, flags)
            : new RegExp(input.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);

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
});
