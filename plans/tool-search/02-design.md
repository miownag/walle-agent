# Tool Search — Design

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│ @walle-agent/core                                                        │
│                                                                          │
│  AgentConfig                                                             │
│   └─ toolSearch?: ToolSearchConfig    ← new                              │
│                                                                          │
│  ToolRegistry  (extend)                                                  │
│   ├─ tools: Map<string, Tool>                                            │
│   ├─ shadowed: Set<string>            ← new                              │
│   ├─ register(tool, opts?: { shadow?: boolean })                         │
│   ├─ shadow(name) / unshadow(name) / isShadowed(name)                    │
│   ├─ listActive() / listShadowed() / list() (all)                        │
│   └─ toModelTools()  (only active)                                       │
│                                                                          │
│  builtin-tools/                                                          │
│   ├─ tool-search.ts             ← new                                    │
│   │    createToolSearchTool({ registry })                                │
│   ├─ defer-execute-tool.ts      ← new                                    │
│   │    createDeferExecuteTool({ registry, agent, permissionPolicy })     │
│   └─ index.ts (update — these two are NOT in BUILTIN_TOOLS;              │
│                they are constructed per-agent like task)                 │
│                                                                          │
│  agent-runtime.ts (update)                                               │
│   init():                                                                │
│     ... existing plugin install ...                                      │
│     registerTaskTool();                                                  │
│     applyToolSearchPolicy();          ← NEW                              │
│                                                                          │
│  events.ts (update)                                                      │
│   AgentEventMap += {                                                     │
│     tool_search_done:    { keywords, matches, totalCandidates },         │
│     tool_defer_executed: { qualifiedName, status, durationMs },          │
│   }                                                                      │
└──────────────────────────────────────────────────────────────────────────┘
```

## Module layout

```
packages/core/src/
├── tool-registry.ts                update — shadow API
├── agent-config.ts                 update — toolSearch field + resolve defaults
├── agent-runtime.ts                update — applyToolSearchPolicy() + register search/defer tools
├── agent.ts                        update — listVisibleTools / listHiddenTools
├── events.ts                       update — new events
└── builtin-tools/
    ├── tool-search.ts              new — createToolSearchTool factory
    ├── defer-execute-tool.ts       new — createDeferExecuteTool factory
    └── index.ts                    update — export factories + constants
```

## 1. ToolRegistry shadow

```ts
// packages/core/src/tool-registry.ts (excerpts)

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private shadowed = new Set<string>();

  register(tool: Tool, opts?: { shadow?: boolean }): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
    if (opts?.shadow) this.shadowed.add(tool.name);
  }

  shadow(name: string): boolean {
    if (!this.tools.has(name)) return false;
    this.shadowed.add(name);
    return true;
  }
  unshadow(name: string): boolean {
    return this.shadowed.delete(name);
  }
  isShadowed(name: string): boolean {
    return this.shadowed.has(name);
  }

  listActive(): Tool[] {
    return [...this.tools.values()].filter((t) => !this.shadowed.has(t.name));
  }
  listShadowed(): Tool[] {
    return [...this.tools.values()].filter((t) => this.shadowed.has(t.name));
  }
  list(): Tool[] { return [...this.tools.values()]; }

  toModelTools(): ModelToolDefinition[] {
    return this.listActive().map((tool) => ({ /* unchanged shape */ }));
  }
}
```

`get(name)` 不变 — 执行链路不应被 shadow 影响。

## 2. ToolSearchConfig & resolve

```ts
// packages/core/src/agent-config.ts

export interface ToolSearchConfig {
  enabled?: boolean;             // default true
  mode?: "auto" | "force" | "off"; // default "auto"
  threshold?: number;            // default 30
  alwaysShadowTags?: string[];   // default ["mcp"]
  alwaysActiveTags?: string[];   // default ["builtin"]
}

export interface ResolvedToolSearchConfig {
  enabled: boolean;
  mode: "auto" | "force" | "off";
  threshold: number;
  alwaysShadowTags: string[];
  alwaysActiveTags: string[];
}

// resolveConfig(): merge defaults; "enabled: false" → "mode: off".
```

`AgentConfig.toolSearch` 默认 resolve 为 `{ enabled: true, mode: "auto", threshold: 30, alwaysShadowTags: ["mcp"], alwaysActiveTags: ["builtin"] }`。

## 3. Tool search algorithm

```ts
// packages/core/src/builtin-tools/tool-search.ts

interface KeywordMatcher {
  source: string;
  test(s: string): { matched: boolean; whole: boolean };
}

function compileKeyword(raw: string): KeywordMatcher {
  if (raw.startsWith("/") && raw.lastIndexOf("/") > 0) {
    const last = raw.lastIndexOf("/");
    const re = new RegExp(raw.slice(1, last), raw.slice(last + 1));
    return {
      source: raw,
      test: (s: string) => ({ matched: re.test(s), whole: false }),
    };
  }
  const lower = raw.toLowerCase();
  return {
    source: raw,
    test: (s: string) => {
      const ls = s.toLowerCase();
      if (!ls.includes(lower)) return { matched: false, whole: false };
      const wordRe = new RegExp(`\\b${escapeRegex(lower)}\\b`);
      return { matched: true, whole: wordRe.test(ls) };
    },
  };
}

function score(tool: Tool, kws: KeywordMatcher[]): number {
  let best = 0;
  for (const kw of kws) {
    const inName = kw.test(tool.name);
    const inDesc = kw.test(tool.description ?? "");
    let s = 0;
    if (kw.source.startsWith("/")) {
      if (inName.matched) s = 1.0;
      else if (inDesc.matched) s = 0.7;
    } else if (inName.whole) s = 0.8;
    else if (inDesc.whole) s = 0.5;
    else if (inName.matched) s = 0.6;
    else if (inDesc.matched) s = 0.3;
    best = Math.max(best, s);
  }
  return best;
}
```

`createToolSearchTool({ registry })`:

```ts
return defineTool({
  name: "tool_search",
  description: /* dynamic, see F8 */,
  parameters: { /* … */ },
  riskLevel: "low",
  tags: ["builtin"],
  async execute(input, ctx) {
    const kws = (input.keywords ?? []).map(compileKeyword);
    if (kws.length === 0) return { matches: [], totalCandidates: 0, truncated: false };

    const candidates = registry.list().filter((t) => {
      if (input.servers?.length && !input.servers.includes(serverNameOf(t))) return false;
      if (input.tags?.length && !t.tags?.some((tg) => input.tags!.includes(tg))) return false;
      // exclude self + defer to avoid LLM looping
      if (t.name === "tool_search" || t.name === "defer_execute_tool") return false;
      return true;
    });

    const scored = candidates
      .map((t) => ({ t, s: score(t, kws) }))
      .filter(({ s }) => s > 0)
      .sort((a, b) => b.s - a.s || a.t.name.localeCompare(b.t.name));

    const limit = Math.min(input.limit ?? 20, 50);
    const top = scored.slice(0, limit);

    const matches = top.map(({ t, s }) => ({
      server: serverNameOf(t),
      qualifiedName: t.name,
      toolName: stripServerPrefix(t.name, t.tags),
      description: t.description ?? "",
      parameters: t.parameters,
      tags: t.tags,
      score: round2(s),
      shadowed: registry.isShadowed(t.name),
    }));

    await ctx.agent.getEventBus()?.emit("tool_search_done", {
      keywords: input.keywords, matches, totalCandidates: scored.length,
    });

    return { matches, totalCandidates: scored.length, truncated: scored.length > matches.length };
  },
});
```

`serverNameOf(tool)`: derive from `tags` — `["mcp", "<name>"]` ⇒ `<name>`; `["builtin"]` ⇒ `"builtin"`; default ⇒ `"native"`.

## 4. defer_execute_tool

```ts
// packages/core/src/builtin-tools/defer-execute-tool.ts

return defineTool({
  name: "defer_execute_tool",
  description: /* see F8 */,
  parameters: {
    type: "object",
    properties: {
      qualifiedName: { type: "string", description: "..." },
      arguments: { type: "object", description: "Arguments forwarded to the underlying tool." },
    },
    required: ["qualifiedName", "arguments"],
  },
  riskLevel: "low",
  tags: ["builtin"],
  async execute(input, ctx) {
    if (!input?.qualifiedName || typeof input.qualifiedName !== "string") {
      return { error: "defer_execute_tool: 'qualifiedName' is required" };
    }
    const tool = registry.get(input.qualifiedName);
    if (!tool) {
      return {
        error: "tool not found",
        qualifiedName: input.qualifiedName,
        hint: "Use tool_search to discover available tools.",
      };
    }
    if (tool.name === "defer_execute_tool" || tool.name === "tool_search") {
      return { error: "cannot defer-execute tool_search/defer_execute_tool" };
    }

    // Permission check via the parent runtime's policy. The runtime injects a
    // bound permissionChecker fn into createDeferExecuteTool() at construction.
    const decision = await opts.checkPermission(tool, {
      id: "defer-" + (ctx.metadata?.toolCallId ?? Date.now()),
      name: tool.name,
      arguments: input.arguments ?? {},
    });
    if (!decision.allowed) {
      return { error: "permission denied", reason: decision.reason };
    }

    const start = Date.now();
    try {
      const out = await tool.execute(input.arguments ?? {}, ctx);
      await ctx.agent.getEventBus()?.emit("tool_defer_executed", {
        qualifiedName: input.qualifiedName, status: "success", durationMs: Date.now() - start,
      });
      return out;
    } catch (err) {
      await ctx.agent.getEventBus()?.emit("tool_defer_executed", {
        qualifiedName: input.qualifiedName, status: "error", durationMs: Date.now() - start,
      });
      return { error: String(err) };
    }
  },
});
```

> Wiring: `AgentRuntime.applyToolSearchPolicy()` builds these factories with `{ registry, checkPermission: this.checkPermission.bind(this) }`. Permission policy continues to gate by underlying tool's `riskLevel` / `requiresApproval`.

## 5. AgentRuntime integration

```ts
// agent-runtime.ts — at end of init()

private applyToolSearchPolicy(): void {
  const ts = this.config.toolSearch;
  if (!ts || !ts.enabled || ts.mode === "off") return;

  const all = this.toolRegistry.list();
  const shadowable = all.filter((t) => isShadowable(t, ts));

  if (ts.mode === "auto" && all.length <= ts.threshold) {
    return; // not enough tools to bother
  }
  if (shadowable.length === 0) return;

  for (const t of shadowable) this.toolRegistry.shadow(t.name);

  // register the two helpers AS active tools
  const searchTool = createToolSearchTool({ registry: this.toolRegistry });
  const deferTool = createDeferExecuteTool({
    registry: this.toolRegistry,
    checkPermission: (tool, call) => this.checkPermission(tool, call),
  });
  this.toolRegistry.register(searchTool);
  this.toolRegistry.register(deferTool);
}

function isShadowable(tool: Tool, ts: ResolvedToolSearchConfig): boolean {
  const tags = tool.tags ?? [];
  if (ts.alwaysActiveTags.some((t) => tags.includes(t))) return false;
  if (ts.alwaysShadowTags.some((t) => tags.includes(t))) return true;
  return false;  // tools with no relevant tags are safe by default (not shadowed)
}
```

## 6. Description (dynamic)

```ts
function buildToolSearchDescription(registry: ToolRegistry): string {
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
```

`createToolSearchTool` 注册时调用一次即可（registry 在该时点已稳定）。

## 7. Public API surface

```ts
// @walle-agent/core
export { createToolSearchTool, type ToolSearchInput, type ToolSearchOutput } from "./builtin-tools/tool-search.js";
export { createDeferExecuteTool, type DeferExecuteInput, type DeferExecuteOutput } from "./builtin-tools/defer-execute-tool.js";
export type { ToolSearchConfig } from "./agent-config.js";
```

## 8. Backward compat

- 默认 `toolSearch.enabled = true` ⇒ **行为变更**：当工具数 > 30 时自动启用 shadow。
- 影响范围有限：MCP 工具会变成可见的 `tool_search` + `defer_execute_tool` 两个新工具，原本的 MCP 工具被隐藏；用户旧 prompt 里如果直接引用 MCP 工具名，LLM 仍能透过 search/defer 触达，行为不会"丢失能力"，只是一两 turn 多绕一下。
- 用户可配置 `toolSearch: { enabled: false }` 完全关闭。
- 子 agent 不受影响（task tool 创建子 agent 走子 agent 自己的 init）。

## 9. Edge cases

| Case | Behaviour |
|---|---|
| 工具数 ≤ threshold（auto） | 不 shadow，不注册 search/defer。 |
| 所有工具都 alwaysActiveTags | shadowable 空 ⇒ 不注册 search/defer。 |
| `keywords: []` | `tool_search` 返回空 matches。 |
| 非法 regex `"/[/"` | compile 时 throw → 整个 search 返回 `{ error }`。 |
| `defer_execute_tool` 被另一个 LLM 试图递归 | 显式 reject `tool_search`/`defer_execute_tool` 自身。 |
| underlying tool throws | 捕获 + 返回 `{ error }`，不 propagate。 |
| permission denied | `{ error: "permission denied", reason }`。 |
| `qualifiedName` 写错 | `{ error: "tool not found", qualifiedName, hint }`。 |
