/**
 * Built-in filesystem tools: ls, read_file, write_file, edit_file, glob, grep.
 *
 * The module-level exports retain the historical process.cwd()-based behavior.
 * `createFilesystemTools({ workspaceRoot })` creates a per-Agent, workspace-bound
 * set for hosts (such as the desktop app) that need a filesystem boundary.
 */

import { promises as fs, realpathSync, statSync } from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import { globSync } from "glob";
import { z } from "zod";
import { defineTool } from "../tool.js";
import type { Tool } from "../tool.js";

export const FILESYSTEM_TOOL_NAMES = [
  "ls",
  "read_file",
  "write_file",
  "edit_file",
  "glob",
  "grep",
] as const;

export interface FilesystemToolsOptions {
  /**
   * Optional filesystem boundary. Relative tool paths resolve from this root;
   * absolute paths are accepted only when they remain inside it.
   *
   * When omitted, tools preserve the historical process.cwd()-based behavior.
   */
  workspaceRoot?: string;
}

export interface FilesystemToolSet {
  readonly lsTool: Tool;
  readonly readFileTool: Tool;
  readonly writeFileTool: Tool;
  readonly editFileTool: Tool;
  readonly globTool: Tool;
  readonly grepTool: Tool;
  /** All six tools in their stable registration order. */
  readonly tools: Tool[];
}

/** Error thrown internally when a bound filesystem request crosses its root. */
export class WorkspacePathError extends Error {
  override readonly name = "WorkspacePathError";
}

interface PathGuard {
  readonly workspaceRoot?: string;
  readonly canonicalWorkspaceRoot?: string;
  resolvePath(inputPath?: string, options?: { allowMissing?: boolean }): Promise<string>;
  assertGlobPattern(pattern: string): void;
}

interface GlobMatch {
  absolutePath: string;
  displayPath: string;
}

function globStaticDirectory(pattern: string): string {
  let escaped = false;
  let firstMagic = -1;

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "*" || char === "?" || char === "[" || char === "{" || char === "(") {
      firstMagic = i;
      break;
    }
  }

  if (firstMagic === -1) return dirname(pattern);
  const slash = Math.max(
    pattern.lastIndexOf("/", firstMagic),
    pattern.lastIndexOf("\\", firstMagic),
  );
  if (slash === -1) return ".";
  if (slash === 0) return pattern.slice(0, 1);
  return pattern.slice(0, slash);
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function hasParentTraversal(inputPath: string): boolean {
  return inputPath.split(/[\\/]+/u).some((segment) => segment === "..");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createPathGuard(workspaceRoot: string | undefined): PathGuard {
  if (workspaceRoot === undefined) {
    return {
      async resolvePath(inputPath) {
        return inputPath ? resolve(inputPath) : process.cwd();
      },
      assertGlobPattern() {
        // Compatibility mode intentionally retains the pre-workspace behavior.
      },
    };
  }

  const configuredRoot = resolve(workspaceRoot);
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(configuredRoot);
    if (!statSync(canonicalRoot).isDirectory()) {
      throw new Error("path is not a directory");
    }
  } catch (error) {
    throw new WorkspacePathError(
      `Invalid workspaceRoot "${configuredRoot}": ${errorMessage(error)}`,
    );
  }

  const assertLexicallyWithinRoot = (candidate: string): void => {
    if (!isWithin(configuredRoot, candidate) && !isWithin(canonicalRoot, candidate)) {
      throw new WorkspacePathError(
        `Path "${candidate}" is outside workspaceRoot "${configuredRoot}"`,
      );
    }
  };

  const assertRealPathWithinRoot = async (
    candidate: string,
    allowMissing: boolean,
  ): Promise<void> => {
    let cursor = candidate;

    while (true) {
      try {
        await fs.lstat(cursor);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!allowMissing || code !== "ENOENT") throw error;

        const parent = dirname(cursor);
        if (parent === cursor) throw error;
        cursor = parent;
        continue;
      }

      let realPath: string;
      try {
        realPath = await fs.realpath(cursor);
      } catch (error) {
        throw new WorkspacePathError(
          `Cannot safely resolve path "${cursor}": ${errorMessage(error)}`,
        );
      }

      if (!isWithin(canonicalRoot, realPath)) {
        throw new WorkspacePathError(
          `Path "${candidate}" escapes workspaceRoot through symlink "${cursor}"`,
        );
      }
      return;
    }
  };

  return {
    workspaceRoot: configuredRoot,
    canonicalWorkspaceRoot: canonicalRoot,
    async resolvePath(inputPath, options) {
      const rawPath = inputPath || ".";
      if (rawPath.includes("\0")) {
        throw new WorkspacePathError("Path must not contain null bytes");
      }
      if (hasParentTraversal(rawPath)) {
        throw new WorkspacePathError(`Path traversal is not allowed: "${rawPath}"`);
      }

      const candidate = isAbsolute(rawPath)
        ? normalize(rawPath)
        : resolve(configuredRoot, rawPath);
      assertLexicallyWithinRoot(candidate);
      await assertRealPathWithinRoot(candidate, options?.allowMissing ?? false);
      return candidate;
    },
    assertGlobPattern(pattern) {
      if (pattern.includes("\0")) {
        throw new WorkspacePathError("Glob pattern must not contain null bytes");
      }
      // Glob expansion can express traversal through braces/extglobs. Rejecting
      // any `..` is deliberately conservative at this trust boundary.
      if (pattern.includes("..")) {
        throw new WorkspacePathError(`Glob path traversal is not allowed: "${pattern}"`);
      }
      if (
        isAbsolute(pattern) &&
        !isWithin(configuredRoot, pattern) &&
        !isWithin(canonicalRoot, pattern)
      ) {
        throw new WorkspacePathError(
          `Glob pattern "${pattern}" is outside workspaceRoot "${configuredRoot}"`,
        );
      }
    },
  };
}

async function findGlobMatches(
  guard: PathGuard,
  pattern: string,
  cwd?: string,
): Promise<{ cwd: string; matches: GlobMatch[] }> {
  guard.assertGlobPattern(pattern);
  const workDir = await guard.resolvePath(cwd);
  const staticDirectory = globStaticDirectory(pattern);
  const absoluteStaticDirectory = isAbsolute(staticDirectory)
    ? staticDirectory
    : resolve(workDir, staticDirectory);
  await guard.resolvePath(absoluteStaticDirectory);

  const rawMatches = globSync(
    pattern,
    guard.workspaceRoot === undefined
      ? { cwd: workDir, absolute: true }
      : {
          cwd: workDir,
          absolute: true,
          follow: false,
          // `follow: false` controls globstar behavior. This callback also
          // blocks ordinary segments from descending into symlink dirs.
          ignore: {
            childrenIgnored: (path) =>
              path.isSymbolicLink() && normalize(path.fullpath()) !== normalize(workDir),
          },
        },
  );
  const absoluteInput = isAbsolute(pattern);
  const matches: GlobMatch[] = [];

  for (const rawMatch of rawMatches) {
    // Realpath validation happens after globbing as a second line of defence.
    // `follow: false` prevents traversal into symlinked directories; this check
    // also rejects a matched symlink whose target itself is outside the root.
    const absolutePath = await guard.resolvePath(rawMatch);
    matches.push({
      absolutePath,
      displayPath: absoluteInput ? absolutePath : relative(workDir, absolutePath),
    });
  }

  return { cwd: workDir, matches };
}

/**
 * Create a complete filesystem tool set. Pass `workspaceRoot` to bind every
 * read/list/search/write/edit operation to one directory tree.
 */
export function createFilesystemTools(
  options: FilesystemToolsOptions = {},
): FilesystemToolSet {
  const guard = createPathGuard(options.workspaceRoot);

  const ls = defineTool(
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
        const dir = await guard.resolvePath(input.path);
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
              // Bound tools use lstat so metadata collection cannot follow an
              // entry symlink outside the root; unbound tools retain stat().
              const stats = guard.workspaceRoot === undefined
                ? await fs.stat(join(dir, name))
                : await fs.lstat(join(dir, name));
              item.size = stats.size;
              item.modified = stats.mtime.toISOString();
            } catch {
              // Skip if stat fails.
            }
          }
          results.push(item);
        }

        if (input.recursive) {
          const recursiveEntries: Array<{ path: string; type: string }> = [];
          const processDir = async (currentPath: string, prefix = ""): Promise<void> => {
            const dirEntries = await fs.readdir(currentPath, { withFileTypes: true });
            for (const entry of dirEntries) {
              const name = entry.name;
              const fullPath = join(currentPath, name);
              const type = entry.isDirectory() ? "dir" : "file";
              recursiveEntries.push({ path: prefix + name, type });

              // Dirent#isDirectory is false for symlinks, so recursive listing
              // never follows a symlinked directory out of the workspace.
              if (entry.isDirectory()) {
                await processDir(fullPath, `${prefix}${name}/`);
              }
            }
          };
          await processDir(dir);
          return {
            path: dir,
            entries: results.length,
            recursiveEntries,
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

  const readFile = defineTool(
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
        const filePath = await guard.resolvePath(input.path);
        const content = await fs.readFile(filePath, "utf-8");
        const lines = content.split("\n");

        const startLine = Math.max(1, input.startLine || 1);
        const endLine = Math.min(lines.length, input.endLine || lines.length);
        const selectedLines = lines.slice(startLine - 1, endLine);

        return {
          path: filePath,
          content: selectedLines.join("\n"),
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

  const writeFile = defineTool(
    "write_file",
    "Write content to a file. Creates the file if it doesn't exist, or overwrites it if it does. Creates parent directories automatically.",
    {
      path: z.string().describe("The file path to write to."),
      content: z.string().describe("The content to write to the file."),
    },
    async (input) => {
      try {
        // For a new path, validating its nearest existing ancestor catches a
        // parent symlink that would otherwise redirect mkdir/write outside.
        const filePath = await guard.resolvePath(input.path, { allowMissing: true });
        await fs.mkdir(dirname(filePath), { recursive: true });
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

  const editFile = defineTool(
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
        const filePath = await guard.resolvePath(input.path);
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
        return { path: filePath, status: "success" };
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

  const glob = defineTool(
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
        const found = await findGlobMatches(guard, input.pattern, input.cwd);
        return {
          pattern: input.pattern,
          cwd: found.cwd,
          matches: found.matches.map((match) => match.displayPath),
          count: found.matches.length,
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

  const grep = defineTool(
    "grep",
    "Search for text patterns in files. Can search a single file or multiple files matching a glob pattern.",
    {
      pattern: z.string().describe("Text or regex pattern to search for."),
      file: z.string().describe("Single file path or glob pattern to search in."),
      ignoreCase: z.boolean().optional().describe("If true, search is case-insensitive."),
      regex: z
        .boolean()
        .optional()
        .describe("If true, treat pattern as regular expression. Default is false (literal string)."),
    },
    async (input) => {
      try {
        const found = await findGlobMatches(guard, input.file);
        if (found.matches.length === 0) {
          return { error: `No files matched pattern: ${input.file}` };
        }

        const results: Array<{
          file: string;
          lines: Array<{ lineNumber: number; content: string }>;
        }> = [];
        const flags = input.ignoreCase ? "i" : "";
        const searchRegex = input.regex
          ? new RegExp(input.pattern, flags)
          : new RegExp(input.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);

        for (const match of found.matches) {
          try {
            const content = await fs.readFile(match.absolutePath, "utf-8");
            const fileLines = content.split("\n");
            const lineMatches = [];

            for (let i = 0; i < fileLines.length; i++) {
              if (searchRegex.test(fileLines[i])) {
                lineMatches.push({ lineNumber: i + 1, content: fileLines[i] });
              }
            }

            if (lineMatches.length > 0) {
              results.push({ file: match.displayPath, lines: lineMatches });
            }
          } catch {
            // Keep historical behavior: skip matched paths that cannot be read.
          }
        }

        return {
          pattern: input.pattern,
          filesSearched: found.matches.length,
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

  return {
    lsTool: ls,
    readFileTool: readFile,
    writeFileTool: writeFile,
    editFileTool: editFile,
    globTool: glob,
    grepTool: grep,
    tools: [ls, readFile, writeFile, editFile, glob, grep],
  };
}

// Backward-compatible process.cwd()-based module-level tools.
const DEFAULT_FILESYSTEM_TOOLS = createFilesystemTools();

export const lsTool = DEFAULT_FILESYSTEM_TOOLS.lsTool;
export const readFileTool = DEFAULT_FILESYSTEM_TOOLS.readFileTool;
export const writeFileTool = DEFAULT_FILESYSTEM_TOOLS.writeFileTool;
export const editFileTool = DEFAULT_FILESYSTEM_TOOLS.editFileTool;
export const globTool = DEFAULT_FILESYSTEM_TOOLS.globTool;
export const grepTool = DEFAULT_FILESYSTEM_TOOLS.grepTool;
