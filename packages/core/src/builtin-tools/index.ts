/**
 * Built-in tools — auto-registered with every agent by default.
 *
 * Tools:
 * - Filesystem: ls, read_file, write_file, edit_file, glob, grep
 * - Shell: bash
 * - Planning: plan
 * - Task management: write_todos
 * - Sub-agent dispatch: task (NOT in BUILTIN_TOOLS — built per-agent at runtime,
 *   see `createTaskTool` factory and AgentRuntime.registerBuiltinTools)
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

import { lsTool, readFileTool, writeFileTool, editFileTool, globTool, grepTool } from "./filesystem-tools.js";
import { bashTool } from "./shell-tool.js";
import { planTool } from "./plan-tool.js";
import { writeTodosTool } from "./todo-tool.js";
import type { Tool } from "../tool.js";

/**
 * Module-level built-in tools, registered as-is in
 * `AgentRuntime.registerBuiltinTools()`.
 *
 * NOTE: the `task` tool is NOT in this array because its description must
 * enumerate the current Agent's registered sub-agent types. The runtime
 * builds a per-Agent instance via `createTaskTool({ registry, defaultModel })`
 * and registers it separately.
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
];
