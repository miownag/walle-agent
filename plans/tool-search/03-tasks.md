# Tool Search — Tasks

> 严格 TDD：每个 T-* 任务先写测试再写实现；测试见 `04-testing.md` 同名 T-*。

## Phase A — ToolRegistry shadow

### T-A1 — `ToolRegistry` shadow API
- `packages/core/src/tool-registry.ts`：
  - 新增 `shadowed: Set<string>`。
  - `register(tool, opts?: { shadow?: boolean })`。
  - `shadow(name)` / `unshadow(name)` / `isShadowed(name)`。
  - `listActive()` / `listShadowed()`，`list()` 行为不变（全部）。
  - `toModelTools()` 仅返回 active。
- 兼容：现有调用 `register(tool)` 行为不变。

### T-A2 — Tool 全局 tag 约定
- 检查/补全：
  - `packages/core/src/builtin-tools/*.ts`：每个 builtin tool 的 `tags` 包含 `"builtin"`。
  - `packages/mcp/src/mcp-tool-adapter.ts`：保持 `["mcp", serverName]`（已有）。
- 文档说明：native tools（`config.tools` 传入）默认无 tag → 不 shadow。

## Phase B — Config & events

### T-B1 — `AgentConfig.toolSearch`
- `packages/core/src/agent-config.ts`：
  - `interface ToolSearchConfig` + `interface ResolvedToolSearchConfig`。
  - `AgentConfig.toolSearch?: ToolSearchConfig`。
  - `ResolvedAgentConfig.toolSearch: ResolvedToolSearchConfig`（默认值参 02-design）。
  - `resolveConfig` 处理 `enabled: false ⇒ mode: "off"`。

### T-B2 — Events
- `packages/core/src/events.ts`：
  - `tool_search_done: { keywords: string[]; matches; totalCandidates: number }`。
  - `tool_defer_executed: { qualifiedName: string; status: "success" | "error" | "denied"; durationMs: number }`。

### T-B3 — Agent 公开 inspection API
- `packages/core/src/agent.ts`：
  - `listVisibleTools(): Tool[]` → `runtime.toolRegistry.listActive()`。
  - `listHiddenTools(): Tool[]` → `runtime.toolRegistry.listShadowed()`。
- `getEventBus()` 同 context-compression slice 复用。

## Phase C — `tool_search`

### T-C1 — `compileKeyword` & `score` 纯函数
- `packages/core/src/builtin-tools/tool-search.ts`：内部导出测试用，外部不暴露。
- 单测覆盖各分支。

### T-C2 — `createToolSearchTool` factory
- 同上文件：导出 `createToolSearchTool({ registry })`。
- 实现完整 execute 逻辑（含 server/tags 过滤、limit、排序、自我排除）。
- 描述文本动态构造：visible/hidden 数。

### T-C3 — Builtin index
- `packages/core/src/builtin-tools/index.ts`：导出 `createToolSearchTool`、不要加到 `BUILTIN_TOOLS` 常量数组（运行时按需注册）。

## Phase D — `defer_execute_tool`

### T-D1 — `createDeferExecuteTool` factory
- `packages/core/src/builtin-tools/defer-execute-tool.ts`：
  - 输入校验 + permission check + 执行透传 + 错误兜底。
  - `checkPermission` 通过参数注入（解耦 runtime）。

### T-D2 — Builtin index 导出
- `packages/core/src/builtin-tools/index.ts`：导出 `createDeferExecuteTool`。

## Phase E — Runtime integration

### T-E1 — `applyToolSearchPolicy()`
- `packages/core/src/agent-runtime.ts`：
  - 在 `init()` 末尾、`registerTaskTool()` 之后调用。
  - 实现 `applyToolSearchPolicy()` + `isShadowable(tool, ts)`（02-design 伪代码）。
  - 注册两个工具时使用 `register(...)` 不带 `shadow: true`。

### T-E2 — 与 `useBuiltinTools` 兼容
- 若用户 `useBuiltinTools.excludeTools` 显式排除 `"tool_search"` 或 `"defer_execute_tool"`：
  - 不注册被排除项；若两者都被排除 → 即使 shadow 了工具也"丢失访问入口"——记一条 `console.warn`。
- 若 `useBuiltinTools: false` ⇒ 不注册 `tool_search`/`defer_execute_tool`，但仍可 shadow（用户用其它方式触达）；为避免 footgun，此时 `applyToolSearchPolicy` 直接 return。

## Phase F — Docs & examples

### T-F1 — `docs/22-tool-search.md`
- 完整 spec：动机、shadow 概念、tool_search 输入/输出、defer_execute_tool 输入/输出、配置、tag 约定、示例。

### T-F2 — `docs/INDEX.md`
- 加 22 行。

### T-F3 — `docs/06-tools.md` / `docs/07-mcp.md` / `docs/20-builtin-tools.md`
- 06：在 ToolRegistry 章节加 shadow 说明。
- 07：MCP plugin 与 tool_search 互动（默认行为）。
- 20：新增 `tool_search` / `defer_execute_tool` 条目。

### T-F4 — `examples/tool-search.ts`
- 演示：注册 60+ mock 工具（生成的）+ MCP 模拟，观察 `agent.listVisibleTools().length` ≪ `listHiddenTools().length`，让 LLM 通过 search/defer 触达隐藏工具。
- `examples/package.json` script `"tool-search": "tsx tool-search.ts"`。

## Phase G — Verification

### T-G1 — 全量测试
- `pnpm -r test` 通过；新增覆盖 ≥ 80%。

### T-G2 — Build + Lint
- `pnpm build`、`pnpm lint`。

## 实施顺序

1. **Phase A**（registry shadow + tag 补齐）
2. **Phase B**（config + events + agent inspection）
3. **Phase C**（tool_search 实现）
4. **Phase D**（defer_execute_tool）
5. **Phase E**（runtime 串起来）
6. **Phase F**（docs + example）
7. **Phase G**（验证）

> 单 PR 即可承载；与 context-compression slice 解耦，可并行开发。
