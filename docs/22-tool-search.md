# 22 — Tool Search

**Status:** Spec (implementation pending)
**Location:** `packages/core/src/tool-registry.ts`, `packages/core/src/builtin-tools/tool-search.ts`, `packages/core/src/builtin-tools/defer-execute-tool.ts`

## 问题

接入多个 MCP server 后，工具数量很容易达到 50–100+。`ToolRegistry.toModelTools()` 把它们全部塞进每次 LLM 调用的 `tools` 字段：

- 每个 MCP 工具一份完整 JSON Schema → 5–15K tokens 起步。
- 大多数工具在大多数会话里都不会被用到。
- 工具数 > 30 时多数 LLM 的 function-calling 准确率明显下滑。

本 spec 引入两层机制：

1. **Shadow**：标记工具"已注册但不在每轮 prompt 里宣告"。
2. **`tool_search` + `defer_execute_tool`**：让 LLM 按关键词检索后再调用 shadow 工具。

参考实现：Cursor / Cline / mcp-host。

---

## 总览

```
ToolRegistry
├── tools: Map<name, Tool>          ← 注册表（不变）
└── shadowed: Set<name>             ← 新增

toModelTools()  =  active tools only       ← 发给 LLM 的工具
get(name)       =  active 与 shadow 都查    ← 执行链路不受 shadow 影响

AgentRuntime.init():
  ... plugin install ...
  registerTaskTool();
  applyToolSearchPolicy();   ← 在最后一步
```

`applyToolSearchPolicy()`：

1. 收集 `registry.list()`。
2. 决定 shadowable 集合（按 tags / config）。
3. 必要时对 shadowable 调 `registry.shadow(name)`。
4. 注册 `tool_search` + `defer_execute_tool` 两个内置工具（active）。

---

## ToolRegistry shadow API

```ts
class ToolRegistry {
  register(tool: Tool, opts?: { shadow?: boolean }): void;

  shadow(name: string): boolean;        // true 若工具存在并被标记
  unshadow(name: string): boolean;
  isShadowed(name: string): boolean;

  listActive(): Tool[];                  // 未被 shadow 的
  listShadowed(): Tool[];                // 被 shadow 的
  list(): Tool[];                        // 全部（行为不变）

  toModelTools(): ModelToolDefinition[]; // 等价于 listActive()
  get(name: string): Tool | undefined;   // 行为不变（active + shadow 都返回）
}
```

---

## 配置

```ts
interface ToolSearchConfig {
  enabled?: boolean;             // 默认 true
  mode?: "auto" | "force" | "off";  // 默认 "auto"
  threshold?: number;            // 默认 30；mode=auto 才有意义
  alwaysShadowTags?: string[];   // 默认 ["mcp"]
  alwaysActiveTags?: string[];   // 默认 ["builtin"]
}

interface AgentConfig {
  // ...
  toolSearch?: ToolSearchConfig;
}
```

| mode | 行为 |
|---|---|
| `"off"` | 完全不 shadow；不注册 search/defer。等价 `enabled: false`。 |
| `"auto"` | 仅当 `registry.list().length > threshold` 时 shadow shadowable 工具。 |
| `"force"` | 不看 threshold，按 tags 规则 shadow。 |

`shadowable(tool)`：
- 工具的 `tags` 包含任意 `alwaysActiveTags` 项 → **永不 shadow**（优先级最高）。
- 否则 `tags` 包含任意 `alwaysShadowTags` 项 → shadow。
- 都不包含 → 不 shadow（默认安全：开发者显式声明的 native tool 都可见）。

> **默认配置含义**：MCP 工具默认 shadowable；built-in 工具永不 shadow。开发者通过 `config.tools` 注入的 native 工具默认可见。

---

## 内置工具：`tool_search`

| 项 | 值 |
|---|---|
| 名称 | `tool_search` |
| Risk | `low` |
| Tags | `["builtin"]` |

### 入参

```ts
{
  keywords: string[];     // OR 语义；每项可纯文本或 "/regex/flags"
  servers?: string[];     // 限定 server 名（无前缀）
  tags?: string[];        // 限定 tag
  limit?: number;         // 默认 20，最大 50
}
```

### 输出

```ts
{
  matches: Array<{
    server: string;          // "builtin" | "native" | <mcp server name>
    qualifiedName: string;   // 注册表里的真实名字（含前缀）
    toolName: string;        // 原始 MCP 工具名（去前缀）
    description: string;
    parameters: JSONSchema;
    tags?: string[];
    score: number;           // 0..1
    shadowed: boolean;
  }>;
  totalCandidates: number;
  truncated: boolean;        // matches.length 是否触达 limit
}
```

### 评分

每个 keyword 对每个工具产出一个分数；多 keyword 取 **max**（OR 语义）。**名字命中永远优于描述命中**，同 location 内 whole-word 优于 substring：

| 优先级 | 命中位置 | 模式 | 分 |
|---|---|---|---|
| 1 | name | regex | 1.0 |
| 2 | description | regex | 0.7 |
| 3 | name | whole word | 0.8 |
| 4 | name | substring | 0.6 |
| 5 | description | whole word | 0.5 |
| 6 | description | substring | 0.3 |
| — | 都没命中 | — | 0（排除） |

排序：score 降序 → name 字典序。

> 注意：whole-word 用 `\b` 检测，因此 `"read"` 在 `"fs_read"` 中不算 whole word（`_` 是 word char），落入 name-substring 档位（0.6）。

### Description 模板（动态）

> Search for available tools by keyword. The agent has **N** registered tools (**M** visible by default, **K** hidden but searchable). Use this when a capability you need is not in your visible tool list. Pair with `defer_execute_tool` to invoke a hidden tool by its `qualifiedName`.

注册时一次性算好（ToolRegistry 在 init 末尾已稳定）。

---

## 内置工具：`defer_execute_tool`

| 项 | 值 |
|---|---|
| 名称 | `defer_execute_tool` |
| Risk | `low`（实际由 underlying tool 决定） |
| Tags | `["builtin"]` |

### 入参

```ts
{
  qualifiedName: string;             // 来自 tool_search.matches[i].qualifiedName
  arguments: Record<string, unknown>;
}
```

### 行为

1. `registry.get(qualifiedName)` → 拿 Tool 实例。未命中 → `{ error: "tool not found", qualifiedName, hint }`。
2. 拒绝执行 `tool_search` / `defer_execute_tool` 自身。
3. 调 runtime 注入的 `checkPermission(tool, call)` —— 走 underlying tool 的 `riskLevel` / `requiresApproval`。拒绝 → `{ error: "permission denied", reason }`。
4. `tool.execute(arguments, ctx)`，透传 `ctx.signal`。捕获 throw 转 `{ error: <message> }`。
5. emit `tool_defer_executed` 事件。

返回：与 underlying tool 一致（成功 → 工具原样输出；失败 → `{ error, ... }`）。

### Description 模板

> Execute a tool that is currently hidden from your tool list. First call `tool_search` to find the tool, then call this with its `qualifiedName` and `arguments`. The tool's permission policy still applies.

---

## Runtime integration

```ts
// AgentRuntime.init() — at the very end
this.applyToolSearchPolicy();

private applyToolSearchPolicy(): void {
  const ts = this.config.toolSearch;
  if (!ts || !ts.enabled || ts.mode === "off") return;
  if (this.config.useBuiltinTools === false) return;

  const all = this.toolRegistry.list();
  const shadowable = all.filter((t) => isShadowable(t, ts));
  if (ts.mode === "auto" && all.length <= ts.threshold) return;
  if (shadowable.length === 0) return;

  for (const t of shadowable) this.toolRegistry.shadow(t.name);

  const includeTools = this.builtinIncludeTools(); // useBuiltinTools.includeTools or null
  const excludeTools = this.builtinExcludeTools();
  const wantSearch = wantsBuiltin("tool_search", includeTools, excludeTools);
  const wantDefer  = wantsBuiltin("defer_execute_tool", includeTools, excludeTools);

  if (!wantSearch && !wantDefer) {
    console.warn(
      "[walle] toolSearch.enabled but useBuiltinTools excluded both helpers; " +
      "shadowed tools will be unreachable.",
    );
    return;
  }

  if (wantSearch) {
    this.toolRegistry.register(createToolSearchTool({ registry: this.toolRegistry }));
  }
  if (wantDefer) {
    this.toolRegistry.register(createDeferExecuteTool({
      registry: this.toolRegistry,
      checkPermission: (tool, call) => this.checkPermission(tool, call),
    }));
  }
}
```

### 与 `useBuiltinTools` 的交互

| 用户配置 | 行为 |
|---|---|
| `useBuiltinTools: false` | 不 shadow，不注册 search/defer（policy 跳过）。 |
| `useBuiltinTools.excludeTools: ["tool_search"]` | 仍 shadow；只注册 `defer_execute_tool`；warn 一次（LLM 没法发现 hidden tool 名）。 |
| `useBuiltinTools.excludeTools: ["defer_execute_tool"]` | 仍 shadow；只注册 `tool_search`；warn（找到了也调不动）。 |
| 都 exclude | shadow 后 warn + 跳过注册。 |
| `useBuiltinTools.includeTools: [...]` | 仅当列表里包含 `tool_search` / `defer_execute_tool` 才注册对应工具。 |

---

## 事件清单

| 事件 | 时机 | Payload |
|---|---|---|
| `tool_search_done` | `tool_search.execute` 末尾 | `{ keywords, matches, totalCandidates }` |
| `tool_defer_executed` | `defer_execute_tool.execute` 末尾 | `{ qualifiedName, status, durationMs }` |

---

## Agent inspection

```ts
class Agent {
  listVisibleTools(): Tool[];   // = registry.listActive()
  listHiddenTools(): Tool[];    // = registry.listShadowed()
}
```

---

## Public API surface

```ts
// @walle-agent/core
export {
  createToolSearchTool,
  type ToolSearchInput,
  type ToolSearchOutput,
} from "./builtin-tools/tool-search.js";

export {
  createDeferExecuteTool,
  type DeferExecuteInput,
  type DeferExecuteOutput,
} from "./builtin-tools/defer-execute-tool.js";

export type { ToolSearchConfig } from "./agent-config.js";
```

---

## 边界 & 兼容

| Case | 行为 |
|---|---|
| 工具数 ≤ threshold（auto） | 不 shadow，不注册 search/defer。 |
| `mode: "force"` 但 shadowable 空 | 不注册 search/defer。 |
| `keywords: []` | 返回空 matches；不报错。 |
| 非法 regex（`/[/`) | `tool_search` 输出 `{ error: "invalid regex …" }`。 |
| `defer_execute_tool` 试图递归调自己 | 返回 `{ error: "cannot defer-execute tool_search/defer_execute_tool" }`。 |
| underlying tool throws | 捕获 → `{ error: <message> }`。 |
| permission 拒绝 | `{ error: "permission denied", reason }`。 |
| `qualifiedName` 不存在 | `{ error: "tool not found", qualifiedName, hint }`。 |
| 子 agent | 不继承 parent shadow；子 agent 自己跑 init 时按其 config 决定。 |

---

## 与现有规格的关系

- 与 [06 — Tools](./06-tools.md) 联动：`ToolRegistry` 概念扩展。
- 与 [07 — MCP Integration](./07-mcp.md) 联动：默认 shadow 含 `"mcp"` tag 的工具。
- 与 [13 — Permissions & Security](./13-permissions.md) 联动：`defer_execute_tool` 强制走 underlying tool 的 permission policy。
- 与 [20 — Built-in Tools](./20-builtin-tools.md) 联动：新增 `tool_search` / `defer_execute_tool`（per-agent 注册，不在 BUILTIN_TOOLS 常量数组里）。
