/**
 * `remember` / `recall` / `forget` — tools registered by MemoryPlugin
 * so the LLM can read/write long-term memory.
 */

import { z } from "zod";
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
  const rememberTool = defineTool(
    "remember",
    "Persist a fact, preference, or decision into long-term memory. Use when the user explicitly says 'remember X', or when you learn durable information (user preferences, project conventions, stable facts). Do NOT use for transient requests.",
    {
      content: z
        .string()
        .describe(
          "The knowledge to remember. One self-contained sentence or short paragraph.",
        ),
      type: z
        .enum(MEMORY_TYPES as [MemoryType, ...MemoryType[]])
        .optional()
        .describe("Kind of memory. Default is 'fact'."),
      tags: z
        .array(z.string())
        .optional()
        .describe("Optional tags for retrieval."),
      importance: z
        .number()
        .optional()
        .describe("0..1; defaults to 0.5."),
    },
    async (input) => {
      const item = await manager.remember({
        content: input.content,
        type: input.type,
        tags: input.tags,
        importance: input.importance,
      });
      return { id: item.id, status: "ok", content: item.content };
    },
    {
      riskLevel: "low",
      tags: ["builtin", "memory"],
      annotations: { openWorldHint: false },
    },
  );

  const recallTool = defineTool(
    "recall",
    "Search long-term memory by keyword. Returns the top matches. Prefer this over asking the user for details they may have already told you.",
    {
      query: z.string().describe("Free-text query."),
      topK: z
        .number()
        .optional()
        .describe("Max number of items to return. Default 5."),
    },
    async (input) => {
      const items = await manager.retrieve(input.query, {
        longTopK: input.topK ?? 5,
      });
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
    {
      riskLevel: "low",
      tags: ["builtin", "memory"],
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
  );

  const forgetTool = defineTool(
    "forget",
    "Delete a memory item by id. Use when the user says to forget / delete / remove something.",
    {
      id: z.string().describe("Memory id returned by remember/recall."),
    },
    async (input) => {
      const ok = await manager.forget(input.id);
      return { deleted: ok, id: input.id };
    },
    {
      riskLevel: "medium",
      requiresApproval: true,
      tags: ["builtin", "memory"],
      annotations: { destructiveHint: true, openWorldHint: false },
    },
  );

  return [rememberTool, recallTool, forgetTool];
}
