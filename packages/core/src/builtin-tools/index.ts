/**
 * Built-in tools — auto-registered with every agent by default.
 *
 * Tools:
 * - Filesystem: ls, read_file, write_file, edit_file, glob, grep
 * - Shell: bash
 * - Planning: plan
 * - Task management: write_todos
 */

export { lsTool, readFileTool, writeFileTool, editFileTool, globTool, grepTool } from "./filesystem-tools.js";
export { bashTool } from "./shell-tool.js";
export { planTool, getPlanStore, clearPlanStore } from "./plan-tool.js";
export type { Plan, PlanStep, PlanToolInput } from "./plan-tool.js";
export { writeTodosTool, getTodoStore, clearTodoStore } from "./todo-tool.js";

import { lsTool, readFileTool, writeFileTool, editFileTool, globTool, grepTool } from "./filesystem-tools.js";
import { bashTool } from "./shell-tool.js";
import { planTool } from "./plan-tool.js";
import { writeTodosTool } from "./todo-tool.js";
import type { Tool } from "../tool.js";

/**
 * All built-in tools as an array.
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
