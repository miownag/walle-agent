# Tool Search — Requirements

## Why this slice

`MCPPlugin.install()` 把所有声明的 server 上的所有 tool 通过 `ctx.registerTool(...)` 一股脑放进 `ToolRegistry`，`ToolRegistry.toModelTools()` 把它们全部塞进每次 LLM 调用的 `tools` 字段。

实际项目里：

- 接 5–10 个 MCP server 后，工具数 50+ 起步，描述文本（每个 tool 的 schema）很容易吃掉 5–15K tokens。
- 大多数 tool 在大多数会话里都不会被用到 — 但仍占模型 prompt cache、占输出概率分布。
- 不同 LLM 在工具数 > 30 时选择准确率明显下滑。

参考 Cursor、Cline、官方 mcp-host 的做法，方案是：

1. **默认隐藏**部分工具，不在每轮 prompt 里宣告。
2. 给 LLM 一个**搜索工具**，让它按关键词检索可用工具。
3. 给 LLM 一个**延后执行工具**，按搜索结果调用任意已隐藏的工具。

这样把"工具元数据 token 成本"从 O(N) 降到 O(被命中工具)。

## Functional requirements

### F1 — `ToolRegistry` shadow 概念

- 给 `ToolRegistry` 增加 shadow 状态：
  ```ts
  class ToolRegistry {
    register(tool: Tool, opts?: { shadow?: boolean }): void;
    shadow(name: string): boolean;
    unshadow(name: string): boolean;
    isShadowed(name: string): boolean;
    listShadowed(): Tool[];
    listActive(): Tool[];   // !shadowed
    list(): Tool[];         // both, like today
    toModelTools(): ModelToolDefinition[]; // === listActive() 转换
  }
  ```
- 默认所有工具 active；shadow 是状态变更，不会丢失工具实例。
- `get(name)` 返回 active 与 shadow 中的任意命中（执行链路保持完整）。

### F2 — 内置工具 `tool_search`

- 名称：`tool_search`
- 入参：
  ```ts
  {
    keywords: string[];     // OR 语义；每项可以是纯文本或 "/regex/flags"
    servers?: string[];     // 限定 MCP server 名（无前缀）
    tags?: string[];        // 限定 tag
    limit?: number;         // 默认 20，max 50
  }
  ```
- 输出：
  ```ts
  {
    matches: Array<{
      server: string;          // "builtin" | "native" | <mcp server name>
      qualifiedName: string;   // ToolRegistry 里的真实名字，如 "mcp_filesystem_read"
      toolName: string;        // 原始 MCP tool 名（去掉前缀）
      description: string;
      parameters: JSONSchema;
      tags?: string[];
      score: number;           // 0..1
      shadowed: boolean;       // 是否当前 shadow
    }>;
    totalCandidates: number;
    truncated: boolean;        // matches.length 是否触达 limit
  }
  ```
- 评分（OR 语义，多 keyword 取 max）：
  - regex 命中 `name` → 1.0；命中 `description` → 0.7
  - 完整词命中 `name` → 0.8；命中 `description` → 0.5
  - 子串命中 `name` → 0.6；命中 `description` → 0.3
  - 0 ⇒ 排除
- 仅命中 `score > 0` 的工具进入 matches；按 score 降序，平手按 name 字母序。

### F3 — 内置工具 `defer_execute_tool`

- 名称：`defer_execute_tool`
- 入参：
  ```ts
  {
    qualifiedName: string;             // tool_search.matches[i].qualifiedName
    arguments: Record<string, unknown>;
  }
  ```
- 行为：
  1. `registry.get(qualifiedName)` → 拿到 Tool 实例（不论 shadow 与否）。
  2. 走完整 permission check（按 underlying tool 的 riskLevel / requiresApproval，不是 defer 自身）。
  3. `tool.execute(arguments, ctx)` → 透传 signal。
  4. 把执行结果原样返回（与正常 tool call 输出格式一致）。
- 错误处理：
  - 未找到 → `{ error: "tool not found", qualifiedName }`。
  - 权限拒绝 → `{ error: "permission denied", reason }`。
  - 执行抛错 → `{ error: <message> }`，不抛异常（由 LLM 自我纠正）。
- riskLevel：定义 `"low"`，**真正的 risk 由 underlying tool 决定**。

### F4 — `AgentConfig.toolSearch`

```ts
toolSearch?: {
  enabled?: boolean;             // 默认 true（auto on）
  mode?: "auto" | "force" | "off";  // 默认 "auto"
  threshold?: number;            // mode=auto 才有意义；工具总数 > threshold 时自动激活；默认 30
  alwaysShadowTags?: string[];   // 默认 ["mcp"]
  alwaysActiveTags?: string[];   // 默认 ["builtin"]
};
```

- `mode: "off"` ⇒ 完全不 shadow，不注册 `tool_search` / `defer_execute_tool`。
- `mode: "force"` ⇒ 不看 threshold，按 tags 规则 shadow。
- `mode: "auto"` ⇒ 工具总数 > threshold 时按 tags 规则 shadow。
- `enabled: false` 等价 `mode: "off"`，但优先级更直观。

### F5 — Shadow 决策时机

- 在 `AgentRuntime.init()` 末尾、所有插件 install 完成、task tool 注册之后执行 `applyToolSearchPolicy()`。
- 决策逻辑：
  1. 跳过 `mode: "off"` 或 `enabled: false`。
  2. 收集 `registry.list()`，按 `tags` 分组。
  3. shadowable = 工具 ∈ tags ⊆ alwaysShadowTags ∧ 工具 ∉ tags ⊆ alwaysActiveTags。
  4. 若 `mode === "auto" && registry.list().length <= threshold` → 不 shadow。
  5. 否则把 shadowable 全部置 shadow。
  6. 注册 `tool_search` + `defer_execute_tool`（active）。
- 如果 shadowable 集为空 ⇒ 不注册 search/defer（避免给 LLM 无意义的多余工具）。

### F6 — Tag 约定

- MCP plugin 已经给每个 MCP tool 加 `tags: ["mcp", serverName]`（见 `mcp-tool-adapter.ts` line 71）—— 已 OK。
- Built-in tools 加 `tags: ["builtin"]`（少数已经有，统一补齐）。
- Native tools（`config.tools` 传入的）默认无 tag —— 也就是默认不 shadow，符合"开发者显式声明的工具默认可见"的直觉。

### F7 — 子 agent 隔离

- `task` 工具创建子 agent 时不传播 shadow 状态（子 agent 自己跑 init 流程；根据子 agent config 决定）。
- 子 agent 默认 `useBuiltinTools: false` ⇒ 不会自动拿到 `tool_search`/`defer_execute_tool`；想要可显式 includeTools。

### F8 — 描述模板（影响 LLM 选择质量）

- `tool_search` description（动态）：
  > Search for available tools by keyword. The agent has registered N tools (M shown by default, K hidden — searchable). Use this when you need a capability not in the visible tool list. Returns matches with their full schemas; pair with defer_execute_tool to invoke a hidden tool.
- `defer_execute_tool` description：
  > Execute a tool that is currently hidden from your tool list. First call tool_search to find the tool, then call this with its qualifiedName and arguments. The tool's permission policy still applies.

### F9 — Native list-only API

- `Agent` 公开（内部）：
  - `agent.listVisibleTools(): Tool[]`
  - `agent.listHiddenTools(): Tool[]`
- 用于 trace / debugging / 用户 inspection。

## Non-functional requirements

- **零运行时新依赖**：评分用纯 TS 实现，无 fuse.js / lunr 等外部库。
- **不影响 MCPPlugin 等已有插件**：shadow 策略由 runtime 单边决策，插件无需感知。
- **性能**：< 500 工具时线性扫描 + 评分 ≤ 5ms（基于 description 截断到 1KB）。后续 v2 可建倒排。
- **观测**：在 trace 插件未启用情况下，`AgentContext.events` emit `tool_search_done` / `tool_defer_executed` 两个事件以便插件订阅。

## Out of scope (deferred)

- "Promote on search"：搜到的工具临时移回 active —— 会让每轮 LLM tools 列表抖动，破坏 prompt cache，v2 评估。
- 基于 embedding 的语义搜索 —— v2。
- 把 shadow 策略下放到 MCPPlugin（让插件自己决定哪些工具 shadow）—— v2 通过 `MCPServerConfig.deferred?: boolean` 提供 hint。
- 搜索结果缓存（同样 keywords 短时内多次调）—— v2。
- 子 agent 共享 parent shadow registry —— v2。
