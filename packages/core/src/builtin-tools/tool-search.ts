/**
 * `tool_search` — built-in tool factory for the dynamic tool-search /
 * defer-execute mechanism. See `docs/22-tool-search.md`.
 *
 * Per-Agent (not module-level singleton) because its description embeds
 * runtime stats about visible / hidden tool counts.
 */

import { defineTool } from "../tool.js";
import type { Tool } from "../tool.js";
import type { ToolRegistry } from "../tool-registry.js";
import type { JSONSchema } from "../types.js";
import type { EventBus } from "../events.js";

export const TOOL_SEARCH_NAME = "tool_search";
export const DEFER_EXECUTE_NAME = "defer_execute_tool";

// ─── Input / Output ────────────────────────────────────────────────

export interface ToolSearchInput {
  keywords: string[];
  servers?: string[];
  tags?: string[];
  limit?: number;
}

export interface ToolSearchMatch {
  server: string;
  qualifiedName: string;
  toolName: string;
  description: string;
  parameters: JSONSchema;
  tags?: string[];
  score: number;
  shadowed: boolean;
}

export interface ToolSearchOutput {
  matches: ToolSearchMatch[];
  totalCandidates: number;
  truncated: boolean;
}

export interface ToolSearchErrorOutput {
  error: string;
}

// ─── Factory options ───────────────────────────────────────────────

export interface CreateToolSearchOptions {
  registry: ToolRegistry;
}

// ─── Internals (exported for tests) ────────────────────────────────

interface KeywordMatcher {
  source: string;
  isRegex: boolean;
  test(s: string): { matched: boolean; whole: boolean };
}

const PLAIN_WORD_BOUNDARY = /^[a-zA-Z0-9_]+$/;

export function compileKeyword(raw: string): KeywordMatcher {
  if (raw.startsWith("/") && raw.lastIndexOf("/") > 0) {
    const last = raw.lastIndexOf("/");
    const pattern = raw.slice(1, last);
    const flags = raw.slice(last + 1);
    const re = new RegExp(pattern, flags);
    return {
      source: raw,
      isRegex: true,
      test: (s: string) => ({ matched: re.test(s), whole: false }),
    };
  }
  const lower = raw.toLowerCase();
  return {
    source: raw,
    isRegex: false,
    test: (s: string) => {
      if (!s) return { matched: false, whole: false };
      const ls = s.toLowerCase();
      if (!ls.includes(lower)) return { matched: false, whole: false };
      let whole = false;
      if (PLAIN_WORD_BOUNDARY.test(lower)) {
        const wordRe = new RegExp(`\\b${escapeRegex(lower)}\\b`);
        whole = wordRe.test(ls);
      }
      return { matched: true, whole };
    },
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function scoreTool(tool: Tool, kws: KeywordMatcher[]): number {
  const name = tool.name;
  const desc = tool.description ?? "";
  let best = 0;
  for (const kw of kws) {
    const inName = kw.test(name);
    const inDesc = kw.test(desc);
    let s = 0;
    if (kw.isRegex) {
      if (inName.matched) s = 1.0;
      else if (inDesc.matched) s = 0.7;
    } else {
      // Plain keyword tier order: name beats description; whole-word beats
      // substring within each location.
      if (inName.whole) s = 0.8;
      else if (inName.matched) s = 0.6;
      else if (inDesc.whole) s = 0.5;
      else if (inDesc.matched) s = 0.3;
    }
    if (s > best) best = s;
  }
  return best;
}

export function deriveServerName(tool: Tool): string {
  const tags = tool.tags ?? [];
  const mcpIdx = tags.indexOf("mcp");
  if (mcpIdx >= 0 && tags.length > mcpIdx + 1) {
    return tags[mcpIdx + 1];
  }
  if (tags.includes("builtin")) return "builtin";
  return "native";
}

export function deriveBaseToolName(qualifiedName: string, tool: Tool): string {
  const server = deriveServerName(tool);
  if (server !== "builtin" && server !== "native") {
    const prefix = `mcp_${server}_`;
    if (qualifiedName.startsWith(prefix)) return qualifiedName.slice(prefix.length);
  }
  return qualifiedName;
}

// ─── Description helpers ───────────────────────────────────────────

export function buildToolSearchDescription(registry: ToolRegistry): string {
  const total = registry.list().length;
  const visible = registry.listActive().length;
  const hidden = registry.listShadowed().length;
  return [
    `Search for available tools by keyword.`,
    `The agent has ${total} registered tools (${visible} visible by default, ${hidden} hidden but searchable).`,
    `Use this when a capability you need is not in your visible tool list.`,
    `Pair with defer_execute_tool to invoke a hidden tool by its qualifiedName.`,
  ].join(" ");
}

// ─── Factory ────────────────────────────────────────────────────────

interface AgentWithEventBus {
  getEventBus?(): EventBus | undefined;
}

export function createToolSearchTool(
  opts: CreateToolSearchOptions,
): Tool<ToolSearchInput, ToolSearchOutput | ToolSearchErrorOutput> {
  const { registry } = opts;
  return defineTool<ToolSearchInput, ToolSearchOutput | ToolSearchErrorOutput>({
    name: TOOL_SEARCH_NAME,
    description: buildToolSearchDescription(registry),
    parameters: {
      type: "object",
      properties: {
        keywords: {
          type: "array",
          items: { type: "string" },
          description:
            "Keywords to search by. OR semantics — a tool matching ANY keyword scores. " +
            'Each entry is plain text (case-insensitive substring) or "/regex/flags".',
        },
        servers: {
          type: "array",
          items: { type: "string" },
          description: 'Restrict to specific server names (e.g. "filesystem", "builtin").',
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Restrict to tools with at least one of these tags.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results. Default 20, max 50.",
        },
      },
      required: ["keywords"],
    },
    riskLevel: "low",
    tags: ["builtin"],

    async execute(input, ctx) {
      const keywords = Array.isArray(input?.keywords) ? input.keywords.filter(Boolean) : [];
      if (keywords.length === 0) {
        return { matches: [], totalCandidates: 0, truncated: false };
      }
      let kws: KeywordMatcher[];
      try {
        kws = keywords.map(compileKeyword);
      } catch (err) {
        return {
          error: `tool_search: invalid keyword — ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      const wantedServers = input.servers && input.servers.length > 0 ? new Set(input.servers) : null;
      const wantedTags = input.tags && input.tags.length > 0 ? new Set(input.tags) : null;

      const candidates = registry.list().filter((t) => {
        if (t.name === TOOL_SEARCH_NAME || t.name === DEFER_EXECUTE_NAME) return false;
        if (wantedServers && !wantedServers.has(deriveServerName(t))) return false;
        if (wantedTags && !(t.tags ?? []).some((tg) => wantedTags.has(tg))) return false;
        return true;
      });

      const scored = candidates
        .map((t) => ({ t, s: scoreTool(t, kws) }))
        .filter(({ s }) => s > 0)
        .sort((a, b) => b.s - a.s || a.t.name.localeCompare(b.t.name));

      const limit = Math.min(Math.max(1, input.limit ?? 20), 50);
      const top = scored.slice(0, limit);

      const matches: ToolSearchMatch[] = top.map(({ t, s }) => ({
        server: deriveServerName(t),
        qualifiedName: t.name,
        toolName: deriveBaseToolName(t.name, t),
        description: t.description ?? "",
        parameters: t.parameters,
        tags: t.tags,
        score: Math.round(s * 100) / 100,
        shadowed: registry.isShadowed(t.name),
      }));

      const out: ToolSearchOutput = {
        matches,
        totalCandidates: scored.length,
        truncated: scored.length > matches.length,
      };

      const events = (ctx.agent as unknown as AgentWithEventBus).getEventBus?.();
      if (events) {
        await events.emit("tool_search_done", {
          keywords: input.keywords,
          matches,
          totalCandidates: scored.length,
        });
      }

      return out;
    },
  });
}
