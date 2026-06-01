/**
 * Built-in tools — auto-registered with every agent by default.
 *
 * Tools:
 * - Filesystem: ls, read_file, write_file, edit_file, glob, grep
 * - Shell: bash
 * - Planning: plan
 * - Task management: write_todos
 * - Context compression: read_tool_result
 * - Sub-agent dispatch: task (NOT in BUILTIN_TOOLS — built per-agent at runtime,
 *   see `createTaskTool` factory and AgentRuntime.registerBuiltinTools)
 * - Tool search: tool_search, defer_execute_tool (NOT in BUILTIN_TOOLS —
 *   built per-agent by AgentRuntime.applyToolSearchPolicy when shadowing
 *   actually kicks in).
 */

export { lsTool, readFileTool, writeFileTool, editFileTool, globTool, grepTool } from "./filesystem-tools.js";
export { bashTool } from "./shell-tool.js";
export { planTool, getPlanStore, clearPlanStore } from "./plan-tool.js";
export type { Plan, PlanStep, PlanToolInput } from "./plan-tool.js";
export { writeTodosTool, getTodoStore, clearTodoStore } from "./todo-tool.js";
export { createTaskTool, TASK_TOOL_NAME } from "./task-tool.js";
export type {
  TaskToolInput,
  TaskToolOutput,
  TaskToolSuccessOutput,
  TaskToolErrorOutput,
  CreateTaskToolOptions,
} from "./task-tool.js";
export { readToolResultTool, READ_TOOL_RESULT_NAME } from "./read-tool-result.js";
export type {
  ReadToolResultInput,
  ReadToolResultOutput,
  ReadToolResultErrorOutput,
} from "./read-tool-result.js";
export {
  createToolSearchTool,
  TOOL_SEARCH_NAME,
  DEFER_EXECUTE_NAME,
  buildToolSearchDescription,
  compileKeyword,
  scoreTool,
  deriveServerName,
} from "./tool-search.js";
export type {
  ToolSearchInput,
  ToolSearchOutput,
  ToolSearchMatch,
  ToolSearchErrorOutput,
  CreateToolSearchOptions,
} from "./tool-search.js";
export { createDeferExecuteTool } from "./defer-execute-tool.js";
export type {
  DeferExecuteInput,
  DeferExecuteOutput,
  DeferExecuteErrorOutput,
  CreateDeferExecuteOptions,
  CheckPermissionFn,
} from "./defer-execute-tool.js";

import { lsTool, readFileTool, writeFileTool, editFileTool, globTool, grepTool } from "./filesystem-tools.js";
import { bashTool } from "./shell-tool.js";
import { planTool } from "./plan-tool.js";
import { writeTodosTool } from "./todo-tool.js";
import { readToolResultTool } from "./read-tool-result.js";
import type { Tool } from "../tool.js";

/**
 * Module-level built-in tools, registered as-is in
 * `AgentRuntime.registerBuiltinTools()`.
 *
 * NOTE: `task` / `tool_search` / `defer_execute_tool` are NOT in this array
 * because their description / dispatch list depends on per-Agent state. The
 * runtime builds and registers them in `init()` after plugins have run.
 */
export const BUILTIN_TOOLS: Tool[] = [
  lsTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  globTool,
  grepTool,
  bashTool,
  planTool,
  writeTodosTool,
  readToolResultTool,
];
