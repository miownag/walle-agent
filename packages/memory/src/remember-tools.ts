/**
 * `remember` / `recall` / `forget` — tools registered by MemoryPlugin
 * so the LLM can read/write long-term memory.
 */

import { defineTool, type Tool } from "@walle-agent/core";
import type { MemoryManager } from "./memory-manager.js";
import type { MemoryType } from "./memory-types.js";

const MEMORY_TYPES: MemoryType[] = [
  "fact",
  "preference",
  "summary",
  "procedure",
  "profile",
  "decision",
  "warning",
];

export function buildRememberTools(manager: MemoryManager): Tool[] {
  const rememberTool = defineTool({
    name: "remember",
    description:
      "Persist a fact, preference, or decision into long-term memory. Use when the user explicitly says 'remember X', or when you learn durable information (user preferences, project conventions, stable facts). Do NOT use for transient requests.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The knowledge to remember. One self-contained sentence or short paragraph.",
        },
        type: {
          type: "string",
          enum: MEMORY_TYPES,
          description: "Kind of memory. Default is 'fact'.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for retrieval.",
        },
        importance: {
          type: "number",
          description: "0..1; defaults to 0.5.",
        },
      },
      required: ["content"],
    },
    riskLevel: "low",
    tags: ["builtin", "memory"],
    async execute(input: {
      content: string;
      type?: MemoryType;
      tags?: string[];
      importance?: number;
    }) {
      const item = await manager.remember({
        content: input.content,
        type: input.type,
        tags: input.tags,
        importance: input.importance,
      });
      return { id: item.id, status: "ok", content: item.content };
    },
  });

  const recallTool = defineTool({
    name: "recall",
    description:
      "Search long-term memory by keyword. Returns the top matches. Prefer this over asking the user for details they may have already told you.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Free-text query.",
        },
        topK: {
          type: "number",
          description: "Max number of items to return. Default 5.",
        },
      },
      required: ["query"],
    },
    riskLevel: "low",
    tags: ["builtin", "memory"],
    async execute(input: { query: string; topK?: number }) {
      const items = await manager.retrieve(input.query, { longTopK: input.topK ?? 5 });
      return {
        count: items.length,
        items: items.map((i) => ({
          id: i.id,
          type: i.type,
          content: i.content,
          tags: i.tags,
          updatedAt: i.updatedAt ?? i.createdAt,
        })),
      };
    },
  });

  const forgetTool = defineTool({
    name: "forget",
    description: "Delete a memory item by id. Use when the user says to forget / delete / remove something.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory id returned by remember/recall." },
      },
      required: ["id"],
    },
    riskLevel: "medium",
    requiresApproval: true,
    tags: ["builtin", "memory"],
    async execute(input: { id: string }) {
      const ok = await manager.forget(input.id);
      return { deleted: ok, id: input.id };
    },
  });

  return [rememberTool, recallTool, forgetTool];
}
