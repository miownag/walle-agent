/**
 * ToolRegistry — manages registered tools.
 *
 * Tools can additionally be marked as "shadowed". Shadowed tools remain
 * accessible via `get(name)` (so executions still work), but they are
 * excluded from `listActive()` / `toModelTools()` — i.e. the LLM does not
 * see them in each turn's tool list. This is the substrate for the dynamic
 * tool-search / defer-execute mechanism (see `docs/22-tool-search.md`).
 */

import type { Tool } from "./tool.js";
import type { ModelToolDefinition } from "./message.js";

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private shadowed = new Set<string>();

  register(tool: Tool, opts?: { shadow?: boolean }): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    if (opts?.shadow) this.shadowed.add(tool.name);
  }

  unregister(name: string): boolean {
    this.shadowed.delete(name);
    return this.tools.delete(name);
  }

  /** Mark a tool as shadowed. No-op if the tool is unknown. */
  shadow(name: string): boolean {
    if (!this.tools.has(name)) return false;
    this.shadowed.add(name);
    return true;
  }

  /** Remove the shadow flag. Returns whether the tool was previously shadowed. */
  unshadow(name: string): boolean {
    return this.shadowed.delete(name);
  }

  isShadowed(name: string): boolean {
    return this.shadowed.has(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Every registered tool, regardless of shadow state. */
  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** Only non-shadowed tools — the slice the LLM sees. */
  listActive(): Tool[] {
    return [...this.tools.values()].filter((t) => !this.shadowed.has(t.name));
  }

  /** Only shadowed tools. */
  listShadowed(): Tool[] {
    return [...this.tools.values()].filter((t) => this.shadowed.has(t.name));
  }

  listByTag(tag: string): Tool[] {
    return this.list().filter((t) => t.tags?.includes(tag));
  }

  /**
   * Convert active tools to LLM-compatible ModelToolDefinition list. Shadowed
   * tools are excluded — they are unreachable to the LLM unless surfaced via
   * `tool_search` / `defer_execute_tool`.
   */
  toModelTools(): ModelToolDefinition[] {
    return this.listActive().map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }
}
