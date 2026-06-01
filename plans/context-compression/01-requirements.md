# Context Compression — Requirements

## Why this slice

走读现状（参见根 README + `agent-runtime.ts` / `prompt-builder.ts` / `memory-plugin.ts` / `tool-result-vault.ts` / `token-budget.ts`）后，walle 当前的"上下文压缩"实质上只覆盖一种场景：

| 维度 | 现状 |
|---|---|
| Tool result 落盘 | `ToolResultVault` 仅在 `content.length > 20_000` chars 时落盘成 envelope。 |
| 跨 run 历史回填 | `MemoryPlugin.collect_messages` 把 envelope 渲染成短摘要；只有"上一次 run 是 user-cancelled"才 readFull。 |
| 当前 run 内压缩 | ❌ 完全没有 — `messages[]` 只增不减，所有 tool result 全文驻留。 |
| 总结 / macro 压缩 | ❌ 没有 — 长会话只能靠物理 context window 截断。 |
| Token 预算 | `TokenBudget.allocate()` 只裁 `ContextItem[]`（memory/skills/rag/tools），**不裁 messages**。 |

随着 agent 在一个 run 里做大量探索（grep/read/bash），context 会迅速膨胀直到超出窗口。Claude Code、Cursor、Cline 等都在做两层压缩：

1. **Micro / line-level**：旧 tool result 转占位符，按需 `read_file` 回读。
2. **Macro / conversation summary**：超阈值时把早期对话压成一段摘要。

本 slice 把这两层补齐到 walle，并对齐已有 vault 设施（不重复造轮子）。

## Functional requirements

### F1 — Micro 压缩：按 turn 逐出 tool result

- **轮的定义**：assistant turn — 每次 LLM 输出（含其触发的所有 tool call）算 1 轮。
- **保留窗口**：默认最近 **3 轮**（`keepRecentTurns = 3`），可配置。
- **逐出动作**：把更早 turn 的 `role: "tool"` 消息内容替换为 placeholder 字符串；原始内容已（或同时）写到 `ToolResultVault` 的磁盘文件，可通过 `read_tool_result` / `read_file` 取回。
- **触发位置**：每次 `model.stream()` 调用前（runtime emit 新事件 `compact_messages`，由 memory 插件监听，in-place mutate `messages[]`）。
- **不影响落盘**：`messages.jsonl` 上写入的仍是 envelope（已有逻辑），跨 run 加载历史也按现有规则。本 slice 只新增"当前 run 内"的逐出。
- **复用 vault 落盘策略**：`thresholdChars` 仍可生效，新增"全部落盘"模式（`thresholdChars = 0`）。

### F2 — `read_tool_result` 内置工具

- 名称：`read_tool_result`
- 入参：
  ```ts
  {
    toolCallId: string;     // placeholder 中暴露的 id
    offset?: number;        // 行偏移，默认 0
    limit?: number;         // 行数上限，默认 200
  }
  ```
- 输出：`{ content: string; totalLines: number; truncated: boolean }`
- 行为：
  - 通过 EventBus 找到 vault 路径（memory 插件提供后端）；若 memory 未装，返回 `{ error: "tool result vault not available" }`。
  - 仅访问 vault 目录下文件，禁止路径穿越。
- riskLevel: `"low"`，无审批。

### F3 — Macro 压缩：长上下文摘要

- **触发**：
  - 自动：在 turn 之间检查（不是 turn 中），估算 `messages` token > `maxContextTokens × threshold`（默认 0.8）。
  - 手动：`agent.compact({ keepRecentTurns? })` 公开 API。
- **默认开关**：`enabled: false`（避免意外的 LLM 总结调用费用）。
- **保留**：最近 `keepRecentTurns`（默认 3）轮原文。
- **压缩对象**：从 system 之后到"最近 3 轮起点"之间所有消息，整体压成 1 条 `role: "user"` 消息：
  ```
  [Summary of N earlier messages]
  - <bullet 1>
  - <bullet 2>
  ...
  ```
- **顺序**：micro 先跑（已在 turn 间）→ 估算 token → 必要时 macro。Macro 输入即 micro 之后的精简版。
- **总结模型**：默认沿用 `agent.model`，可指定更便宜的 provider（如 Haiku）。
- **持久化**：`runs.jsonl` append 一条 `compaction` 记录 `{ compactedAt, beforeMsgCount, afterMsgCount, summarySnippet }`；`messages.jsonl` 不删除（保留证据）。

### F4 — `agent.compact()` Public API

```ts
class Agent {
  /**
   * 主动触发宏压缩。要求当前没有运行中的 run（`isRunning() === false`）。
   * 返回压缩前后估算 token 与 dropped message 数。
   */
  async compact(options?: {
    keepRecentTurns?: number;
    summaryModel?: LLMProvider;
  }): Promise<{
    summary: string;
    beforeTokens: number;
    afterTokens: number;
    droppedMessages: number;
  }>;
}
```

- 不在 run 中：直接读 `messages.jsonl` → 摘要 → 写新一轮 history（下一个 run 的 `collect_messages` 会用到）。
- 实现细节：摘要写到一个 `summaries/<runId>.md` 文件，`runs.jsonl` 引用该文件；`MemoryPlugin.collect_messages` 在加载时如果发现 active summary，按摘要起点裁剪历史并把摘要插入。

### F5 — 配置面板

#### `MemoryPluginConfig.toolResults`（替代旧 `largeToolResults`，向后兼容旧字段）

```ts
toolResults?: {
  enabled?: boolean;             // 默认 true
  dir?: string;
  /** 落盘的字符阈值；0 = 全部落盘（micro 压缩需要）。默认 0。 */
  thresholdChars?: number;
  /** 当前 run 内保留完整内容的最近 turn 数。默认 3。 */
  keepRecentTurns?: number;
  previewHeadLines?: number;     // 默认 10（旧默认 30，更紧凑）
  previewTailLines?: number;     // 默认 10
};
```

旧字段 `largeToolResults` 仍然解析（deprecation warning），值合并进 `toolResults`。

#### `AgentConfig.macroCompression`

```ts
macroCompression?: {
  enabled?: boolean;             // 默认 false
  threshold?: number;            // 0..1，默认 0.8
  keepRecentTurns?: number;      // 默认 3
  summaryModel?: LLMProvider;    // 默认沿用 agent.model
  summaryPrompt?: string;        // 默认提供
  manualOnly?: boolean;          // true → 关闭自动检查，仅 agent.compact() 触发。默认 false。
};
```

### F6 — 新事件：`compact_messages`

- 加在 `events.ts` `AgentEventMap`：
  ```ts
  compact_messages: {
    messages: ModelMessage[];   // in-place mutable
    keepRecentTurns: number;
    runId: string;
    sessionId?: string;
  };
  ```
- `MemoryPlugin` 在 `install()` 时 `ctx.events.on("compact_messages", …)` 注册监听，按 turn 切片 + 替换 placeholder。
- `AgentRuntime.executeGenerator` 在每次 `model.stream()` 之前 emit 该事件（首轮无意义但不报错；总是执行可让插件做更多控制）。

### F7 — Placeholder 文本格式

每个被逐出的 tool message 的 `content` 重写为：

```
[ToolResult #<idx> evicted | tool=<name> | toolCallId=<id> | size=<N> chars]
Use read_tool_result(toolCallId="<id>") or read_file(path="<abs>") to load the full content.

<head N lines>
... [<M> lines truncated] ...
<tail N lines>
```

`<idx>` 由 vault 内部维护单调递增计数（持久化到 `index.jsonl`），方便人和 LLM 引用。

## Non-functional requirements

- **不破 core 零运行时依赖**：micro/macro 的核心逻辑（消息切片、摘要 prompt 构造）放在 `core/src/message-compactor.ts` 与 `core/src/conversation-summarizer.ts`，纯函数 + 类型；磁盘读写仍由 memory 插件承担。
- **向后兼容**：未启用 micro / macro 时，运行行为 100% 等同 v0.1（micro 默认随 memory 开启；不装 memory 完全不受影响）。
- **可测**：所有压缩逻辑均为纯函数 + 注入的 LLM 摘要 fn → 用 mock provider 单测。
- **观测**：`compact_messages` 事件本身可被 trace 插件订阅；macro 压缩后通过 `EventBus.emit("compaction_done", …)` 发出（新事件，phase 2 加 trace 字段）。

## Out of scope (deferred)

- 基于 embedding 的 turn-level 智能选择（"哪轮重要"）— 默认按时间近-远裁剪即可。
- summary-of-summary 递归压缩（防失真，先警告即可）。
- 流式摘要（macro 压缩时 LLM 调用走非流式即可）。
- 子 agent（task tool 调起的）继承父 agent 的压缩策略 — 后续 phase。
- 对话过长时主动 evict ContextItem（当前 TokenBudget 已能处理 ContextItem，micro 压缩仅针对 messages）。
