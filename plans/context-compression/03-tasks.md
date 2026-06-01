# Context Compression — Tasks

> 严格 TDD：每个 T-* 任务先写测试再写实现；测试见 `04-testing.md` 同名 T-*。

## Phase A — Core foundations (no I/O)

### T-A1 — Token estimator promotion
- 把 `TokenBudget` 内私有 `estimateTokens` 抽到 `packages/core/src/token-estimate.ts`，导出 `estimateTokens(content: string | ModelMessage[])`。
- `TokenBudget` 改为内部调用新函数，行为等价。

### T-A2 — `message-compactor.ts`
- 文件：`packages/core/src/message-compactor.ts`
- 导出：
  - `partitionByTurns(messages, keepRecentTurns) → PartitionResult`
  - `buildPlaceholder(input) → string`
  - 类型：`PartitionResult`, `PlaceholderInput`
- 纯函数，零依赖。

### T-A3 — `conversation-summarizer.ts`
- 文件：`packages/core/src/conversation-summarizer.ts`
- 导出：
  - `DEFAULT_SUMMARY_PROMPT` 常量
  - `summariseConversation({ model, messages, promptTemplate?, signal? }) → Promise<string>`
  - `renderMessagesForSummary(messages) → string`（内部）
- 不直接依赖 vault / memory。

### T-A4 — Events: `compact_messages` / `compaction_done` / `vault_read`
- `packages/core/src/events.ts`：`AgentEventMap` 加 3 个事件类型。
- 类型字段对齐 02-design 的定义；`vault_read` 的 `result` 字段为 `{ value?: ReadSliceOutput }`，由订阅者写入。

### T-A5 — `AgentConfig.macroCompression`
- `packages/core/src/agent-config.ts`：
  - `interface MacroCompressionConfig { enabled?, threshold?, keepRecentTurns?, summaryModel?, summaryPrompt?, manualOnly? }`
  - `AgentConfig.macroCompression?: MacroCompressionConfig`
  - `ResolvedAgentConfig.macroCompression: Required<MacroCompressionConfig> | null`（默认 null）
  - `resolveConfig` 设置默认值。

### T-A6 — `ModelMessage.metadata` 透传
- `packages/core/src/message.ts`：`ModelMessage` 增加可选 `metadata?: Record<string, unknown>`。
- `agent-runtime.ts` 在 push tool message 时附加 `{ toolName, status }`：
  ```ts
  messages.push({
    role: "tool",
    toolCallId: call.id,
    content: serializeToolOutput(record.output),
    metadata: { toolName: call.name, status: record.status },
  });
  ```

## Phase B — Built-in tool: `read_tool_result`

### T-B1 — `read-tool-result.ts`
- 文件：`packages/core/src/builtin-tools/read-tool-result.ts`
- 实现：emit `vault_read` 事件，读取 `payload.result.value`。
- 加入 `BUILTIN_TOOLS` 数组、`builtin-tools/index.ts` 导出。
- 在 `useBuiltinTools.includeTools` 列表里也支持单独开/关。

### T-B2 — Agent eventBus 暴露
- `packages/core/src/agent.ts`：`getEventBus(): EventBus`（内部用，注释清楚）。
- `read_tool_result` 通过该 API 拿 EventBus 发 `vault_read`。

## Phase C — Memory plugin: vault upgrades

### T-C1 — Vault: 全量落盘 + index.jsonl
- `packages/memory/src/tool-result-vault.ts`：
  - 默认 `thresholdChars = 0`（保留 backward-compat：`largeToolResults.thresholdChars` 仍可覆盖）。
  - 维护 `index.jsonl`：每次首次 ensure append `{ idx, toolCallId, toolName, ts, size, status }`。
  - 新方法 `ensure(params): Promise<EvictedToolResult & { idx: number }>` —— 已存在则不写文件，但补齐 idx。
  - 新方法 `readSlice(toolCallId, { offset?, limit? }): Promise<ReadSliceOutput>`：按行切片。

### T-C2 — Memory plugin: 配置兼容
- `packages/memory/src/memory-types.ts`：
  - 新 `toolResults?` 字段，类型同 `largeToolResults?`。
  - `MemoryPluginConfig` 同时保留旧字段；构造时合并并对旧字段一次性 `console.warn` 提示。
  - 新增 `toolResults.keepRecentTurns?: number`（默认 3）。

### T-C3 — Memory plugin: `compact_messages` 监听
- `packages/memory/src/memory-plugin.ts`：
  - install 中 `ctx.events.on("compact_messages", this.handleCompactMessages)`。
  - 实现 `handleCompactMessages(payload)`：按 `partitionByTurns` 找 evictable，对 `role: "tool"` 消息：
    - 已是 envelope（`tryDecodeEviction` 命中）→ 用 envelope 重渲染 placeholder。
    - 否则 → `vault.ensure(...)` 后渲染 placeholder。
- 跳过条件：`vault` 未启用、`role !== "tool"`、消息已被 placeholder 化（用 sentinel `[ToolResult #` 检测）。

### T-C4 — Memory plugin: `vault_read` 后端
- `ctx.events.on("vault_read", this.handleVaultRead)`：
  - `vault.readSlice(toolCallId, { offset, limit })` → 写到 `payload.result.value`。
  - 不存在 → `payload.result.value = { error: "tool result not found" }`。

### T-C5 — afterToolCall 改写
- 当前 `afterToolCall` 逻辑里"超阈值才落盘"保留；但若 `thresholdChars === 0` ⇒ 永远调 `ensure`。
- 写 `messages.jsonl` 时仍写 envelope（兼容历史回填）。

## Phase D — Runtime integration

### T-D1 — emit `compact_messages`
- `agent-runtime.ts` `executeGenerator` 主循环 turn 顶部：
  ```ts
  await this.eventBus.emit("compact_messages", {
    messages,
    keepRecentTurns: this.resolvedKeepRecentTurns(),
    runId, sessionId,
  });
  ```
- `resolvedKeepRecentTurns()`：优先 `macroCompression.keepRecentTurns`，否则取 memory plugin 暴露的 `__toolResultsKeepRecentTurns` 默认 3。

### T-D2 — Macro auto-check
- `agent-runtime.ts`：抽出 `private async maybeMacroCompact(messages, runId, sessionId)`：
  - 若 `config.macroCompression?.enabled && !manualOnly` → 估 token，超阈值则调 `runMacroCompact`。
- 在 turn 顶部、`compact_messages` 之后调用。

### T-D3 — `runMacroCompact()`
- 私有方法：
  1. `partitionByTurns(messages, keepRecentTurns)`
  2. `head`、`tail` 切分；system 永远在 head 之首。
  3. 已有 sentinel-prefixed user message（`[Summary of N earlier messages]`）→ 视为前次摘要，并入 head 后保留位置（避免 stack）。
  4. `summary = await summariseConversation({ model: summaryModel ?? config.model, messages: head, ... })`
  5. in-place mutate `messages` to `[systemMsgs..., summaryUserMsg, ...tail]`。
  6. `eventBus.emit("compaction_done", { runId, sessionId, before, after, summary })`。

### T-D4 — `Agent.compact()` public
- `agent.ts`：实现 `compact(options)`，参考 02-design 的伪代码。
- 调用前用 `this.runtime.isRunning()` 守卫；运行时抛错。

### T-D5 — `MemoryPlugin` 持久化压缩日志
- 监听 `compaction_done`：
  - 写 `<sessionDir>/summaries/<runId>-<ts>.md`
  - `runs.jsonl` append `{ runId, kind: "compaction", path, beforeMsgCount, afterMsgCount, ts }`
- `collect_messages` 在加载时检测 `runs.jsonl` 中存在 `kind: "compaction"`，按规则裁剪并插入摘要。

## Phase E — Docs & examples

### T-E1 — `docs/21-context-compression.md`
- 写 spec：micro / macro / read_tool_result / compact API / 配置。

### T-E2 — `docs/INDEX.md`
- 加 21 行；调整其它文件交叉引用。

### T-E3 — `docs/09-memory.md` / `docs/17-token-budget.md` / `docs/20-builtin-tools.md`
- 09 更新 vault 章节（指向 21）。
- 17 在结尾加交叉引用。
- 20 新增 `read_tool_result`（敏感度、参数）。

### T-E4 — `examples/context-compression.ts`
- 演示：开启 macroCompression，跑 N 轮模拟工具调用，触发自动压缩；手动 `agent.compact()`。
- `examples/package.json` 加 script `"compaction": "tsx context-compression.ts"`。

## Phase F — Verification

### T-F1 — 全量测试
- `pnpm -r test` 通过，新增覆盖率 ≥ 80%（参 04-testing.md）。

### T-F2 — Build
- `pnpm build` 通过；`packages/core` / `packages/memory` 都有正确 dist。

### T-F3 — Lint
- `pnpm lint` 通过。

## 实施顺序

1. **Phase A** 全做（纯函数、易测）
2. **Phase B** `read_tool_result`（依赖 A4 事件）
3. **Phase C** 一气呵成（vault + plugin 两端）
4. **Phase D** 收尾（runtime 串起来）
5. **Phase E** 文档 + example
6. **Phase F** 验证

> 单 PR 即可承载（slice 较大但内聚）；如分两步，建议 micro（A1-A6 + B1-B2 + C1-C5 + D1） 一个 PR，macro（A3 复用 + D2-D5 + 文档）第二个 PR。
