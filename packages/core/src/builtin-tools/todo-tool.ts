/**
 * Built-in todo/task management tool: write_todos
 */

import { defineTool } from "../tool.js";

// ─── In-memory Store ──────────────────────────────────────────────

const todoStore = new Map<string, Array<{ id: string; task: string; completed: boolean; createdAt: string }>>();

/**
 * write_todos — Manage task lists for planning complex objectives
 */
export const writeTodosTool = defineTool({
  name: "write_todos",
  description: "Create, update, list, and complete tasks in a todo list. Useful for tracking progress on complex objectives.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["add", "list", "complete", "remove", "clear"],
        description: "Action to perform: 'add' new task, 'list' all tasks, 'complete' a task, 'remove' a task, 'clear' all tasks.",
      },
      task: {
        type: "string",
        description: "Task description. Required for 'add' action.",
      },
      taskId: {
        type: "string",
        description: "Task ID. Required for 'complete' and 'remove' actions.",
      },
      listName: {
        type: "string",
        description: "Name of the todo list. Defaults to 'default'.",
      },
    },
    required: ["action"],
  },
  riskLevel: "low",
  tags: ["builtin", "task-management"],
  async execute(input: { action: string; task?: string; taskId?: string; listName?: string }) {
    try {
      const listName = input.listName || "default";

      if (!todoStore.has(listName)) {
        todoStore.set(listName, []);
      }

      const todos = todoStore.get(listName)!;

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
          todoStore.set(listName, []);
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
});

export function getTodoStore() {
  return todoStore;
}

export function clearTodoStore() {
  todoStore.clear();
}
