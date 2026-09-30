/**
 * Built-in todo/task management tool: write_todos
 */

import { z } from "zod";
import { defineTool } from "../tool.js";

// ─── In-memory Store ──────────────────────────────────────────────

export interface TodoItem {
  id: string;
  task: string;
  completed: boolean;
  createdAt: string;
}

export type TodoStore = Map<string, TodoItem[]>;

/**
 * Backward-compatible store used only by the module-level `writeTodosTool`.
 * AgentRuntime creates a fresh store for each Agent.
 */
const defaultTodoStore: TodoStore = new Map();

/**
 * write_todos — Manage task lists for planning complex objectives
 */
export function createWriteTodosTool(store: TodoStore = new Map()) {
  return defineTool(
    "write_todos",
    "Create, update, list, and complete tasks in a todo list. Useful for tracking progress on complex objectives.",
    {
      action: z
        .enum(["add", "list", "complete", "remove", "clear"])
        .describe(
          "Action to perform: 'add' new task, 'list' all tasks, 'complete' a task, 'remove' a task, 'clear' all tasks.",
        ),
      task: z
        .string()
        .optional()
        .describe("Task description. Required for 'add' action."),
      taskId: z
        .string()
        .optional()
        .describe("Task ID. Required for 'complete' and 'remove' actions."),
      listName: z
        .string()
        .optional()
        .describe("Name of the todo list. Defaults to 'default'."),
    },
    async (input) => {
      try {
        const listName = input.listName || "default";

        const todos = store.get(listName) ?? [];

        switch (input.action) {
          case "add": {
            if (!input.task) {
              return { error: "task is required for 'add' action" };
            }
            const id = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const newTodo = {
              id,
              task: input.task,
              completed: false,
              createdAt: new Date().toISOString(),
            };
            if (!store.has(listName)) store.set(listName, todos);
            todos.push(newTodo);
            return {
              status: "success",
              action: "add",
              listName,
              addedTask: newTodo,
              totalTasks: todos.length,
            };
          }

          case "list": {
            return {
              listName,
              totalTasks: todos.length,
              tasks: todos,
              completed: todos.filter((t) => t.completed).length,
              pending: todos.filter((t) => !t.completed).length,
            };
          }

          case "complete": {
            if (!input.taskId) {
              return { error: "taskId is required for 'complete' action" };
            }
            const todo = todos.find((t) => t.id === input.taskId);
            if (!todo) {
              return { error: `Task ${input.taskId} not found` };
            }
            todo.completed = true;
            return {
              status: "success",
              action: "complete",
              listName,
              completedTask: todo,
              progress: {
                completed: todos.filter((t) => t.completed).length,
                total: todos.length,
              },
            };
          }

          case "remove": {
            if (!input.taskId) {
              return { error: "taskId is required for 'remove' action" };
            }
            const index = todos.findIndex((t) => t.id === input.taskId);
            if (index === -1) {
              return { error: `Task ${input.taskId} not found` };
            }
            const removed = todos.splice(index, 1)[0];
            if (todos.length === 0) store.delete(listName);
            return {
              status: "success",
              action: "remove",
              listName,
              removedTask: removed,
              remainingTasks: todos.length,
            };
          }

          case "clear": {
            const count = todos.length;
            store.delete(listName);
            return {
              status: "success",
              action: "clear",
              listName,
              clearedCount: count,
            };
          }

          default:
            return { error: `Unknown action: ${input.action}` };
        }
      } catch (error) {
        return { error: String(error) };
      }
    },
    {
      riskLevel: "low",
      tags: ["builtin", "task-management"],
      annotations: { openWorldHint: false },
    },
  );
}

/** Alias matching the tool's shorter conceptual name. */
export const createTodoTool = createWriteTodosTool;

/** Backward-compatible singleton. AgentRuntime registers factory instances. */
export const writeTodosTool = createWriteTodosTool(defaultTodoStore);

export function getTodoStore() {
  return defaultTodoStore;
}

export function clearTodoStore() {
  defaultTodoStore.clear();
}
