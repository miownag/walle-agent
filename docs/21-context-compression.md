# 21 — Context Compression

**Status:** Spec (implementation pending)
**Location:** `packages/core/src/message-compactor.ts`, `packages/core/src/conversation-summarizer.ts`, `packages/memory/src/tool-result-vault.ts`, `packages/memory/src/memory-plugin.ts`

## 问题

Agent 在一个 run 里做多步工具调用时，messages 数组只增不减。每条 `role: "tool"` 消息可能携带几 KB 到几十 KB 的输出（grep 大结果、read_file 大文件、bash stdout 等）。结果：

1. 单 run 内迅速吃满 context window；
2. Token 成本与会话长度线性增长；
3. 命中 prompt cache 概率下降。

走读 `docs/09-memory.md` 与 `tool-result-vault.ts` 可以看到，walle 已有"按 size 落盘 + envelope 占位"的雏形，但只在**跨 run 加载历史**时生效，**当前 run 内**没有压缩。本 spec 把压缩拓展为两层：

- **Micro 压缩**：按 turn 逐出旧 tool result（运行时事件驱动）。
- **Macro 压缩**：按阈值或手动 API 把早期对话摘要为单条消息。

---

## 总览

```
       ┌────────────────────────────────────────────────────┐
       │ AgentRuntime.executeGenerator (turn loop)          │
       │                                                    │
       │  ┌──────────────────────────────────────────────┐  │
       │  │ ① emit "compact_messages"                    │  │  ← micro
       │  │   (Memory plugin replaces old tool-result    │  │
       │  │    bodies with placeholders)                 │  │
       │  └──────────────────────────────────────────────┘  │
       │                                                    │
       │  ┌──────────────────────────────────────────────┐  │
       │  │ ② maybeMacroCompact(messages)                │  │  ← macro
       │  │   if enabled & est tokens > threshold:       │  │
       │  │     summariseConversation(model, head)       │  │
       │  │     replace head with single user msg        │  │
       │  │     emit "compaction_done"                   │  │
       │  └──────────────────────────────────────────────┘  │
       │                                                    │
       │  ③ model.stream(messages, tools)                  │
       └────────────────────────────────────────────────────┘
```

> Micro 永远先跑（廉价、纯函数）；Macro 永远在 turn 之间（避免破坏 LLM 推理），并且接收 micro 之后的精简版输入，省钱。

---

## Micro 压缩

### 概念

- **轮的定义**：assistant turn — 每次 LLM 输出（含其触发的所有 tool call）算 1 轮。
- **保留窗口**：默认最近 **3 轮**完整保留；更早 turn 中的 `role: "tool"` 消息内容替换成 placeholder。
- **占位符**：复用 `EvictedToolResult` envelope 落盘机制；占位文本里携带 `toolCallId` + `path` + 短预览。

### 触发流程

`AgentRuntime` 在每次 `model.stream(...)` 之前 emit 新事件 `compact_messages`：

```ts
await this.eventBus.emit("compact_messages", {
  messages,              // ModelMessage[] — in-place mutable
  keepRecentTurns: 3,
  runId, sessionId,
});
```

`MemoryPlugin` 监听该事件，按 `partitionByTurns(messages, 3)` 找出可逐出的 tool 消息，对每条：

1. 已落盘 → `vault.readEnvelope(toolCallId)` 取信封 → 重渲染 placeholder。
2. 未落盘 → `vault.ensure(...)` 写文件 + meta + index → 渲染 placeholder。

### Placeholder 文本格式

```
[ToolResult #<idx> evicted | tool=<name> | toolCallId=<id> | size=<N> chars]
Use read_tool_result(toolCallId="<id>") or read_file(path="<abs path>") to load the full content.

<head N lines>
... [<M> lines truncated] ...
<tail N lines>
```

- `<idx>` 由 vault 维护单调递增计数（`index.jsonl`），人/LLM 可引用。
- `<head/tail N>` 由 `previewHeadLines` / `previewTailLines` 控制（默认各 10）。

### `read_tool_result` 内置工具

| 项 | 值 |
|---|---|
| 名称 | `read_tool_result` |
| 入参 | `{ toolCallId: string; offset?: number; limit?: number }` |
| 输出 | `{ content: string; totalLines: number; truncated: boolean } \| { error: string }` |
| Risk | `low` |

实现层 emit `vault_read` 事件，由 `MemoryPlugin` 调 `vault.readSlice(...)` 写回 `payload.result.value`。Memory 未装时返回 `{ error: "tool result vault not available — install @walle-agent/memory" }`。

### 配置（`MemoryPluginConfig.toolResults`）

```ts
toolResults?: {
  enabled?: boolean;             // 默认 true
  dir?: string;                  // 默认 <rootDir>/memory/large-tool-results
  thresholdChars?: number;       // 默认 0（全量落盘）；>0 仅大输出落盘
  keepRecentTurns?: number;      // 默认 3
  previewHeadLines?: number;     // 默认 10
  previewTailLines?: number;     // 默认 10
};
```

> 旧字段 `largeToolResults` 仍可识别（值合并；首次检测到 `console.warn` 一次）。

---

## Macro 压缩

### 触发条件

- **自动**（默认 off）：当 `messages` 估算 token > `maxContextTokens × threshold`（默认 0.8）时，在 turn 之间触发。
- **手动**（始终可用）：`agent.compact()` 公开 API。

### 摘要消息形态

把"system 消息之后、最近 3 轮起点之前"的所有消息整体替换成 1 条 `role: "user"` 消息：

```
[Summary of N earlier messages]
- 用户目标 / 约束
- 关键事实 / 决定
- 待办 / 未决问题
- 重要的 toolCallId / 文件路径
- 警告 / 错误
```

幂等：检测到 sentinel 前缀 `"[Summary of "`，下次 macro 压缩时**替换而非堆叠**该条。

### 默认 prompt 模板

```
You are summarising a conversation between a user and an AI agent so the agent
can continue with limited context. Preserve:
1. The user's overall goal and constraints
2. Key facts/decisions made
3. Outstanding tasks or pending questions
4. Any tool call ids / file paths the agent may need to reference later
5. Errors or warnings the agent should remember

Output: a markdown bulleted summary, ≤ 800 tokens. Do not invent facts.

<conversation>
{{messages}}
</conversation>
```

可由 `macroCompression.summaryPrompt` 整体覆盖；`{{messages}}` 必须出现一次。

### 配置（`AgentConfig.macroCompression`）

```ts
macroCompression?: {
  enabled?: boolean;             // 默认 false
  threshold?: number;            // 0..1，默认 0.8
  keepRecentTurns?: number;      // 默认 3
  summaryModel?: LLMProvider;    // 默认沿用 agent.model
  summaryPrompt?: string;        // 默认见上
  manualOnly?: boolean;          // true → 仅 agent.compact() 触发
};
```

### `agent.compact()` Public API

```ts
class Agent {
  /**
   * 主动触发宏压缩。要求当前没有运行中的 run。
   */
  async compact(options?: {
    keepRecentTurns?: number;
    summaryModel?: LLMProvider;
  }): Promise<{
    summary: string;
    beforeMessages: number;
    afterMessages: number;
    beforeTokens: number;
    afterTokens: number;
    droppedMessages: number;
  }>;
}
```

### 持久化

- `<sessionDir>/summaries/<runId>-<ts>.md` —— 摘要正文。
- `<sessionDir>/runs.jsonl` —— append 一行：
  ```json
  { "runId":"r-…", "kind":"compaction", "path":"…/summaries/…", "beforeMsgCount":42, "afterMsgCount":7, "ts":"…" }
  ```
- `messages.jsonl` 不删除（保留证据）。
- 下次 `collect_messages` 时，`MemoryPlugin` 检测最近一条 `compaction` 记录，按规则把该 run 之前的消息丢弃，插入摘要。

---

## 顺序 & 互动

```
turn loop:
  emit compact_messages         ← micro
  if macro auto-enabled:
    estimate tokens
    if exceeded: runMacroCompact
  model.stream(messages, tools)
```

Micro 每个 turn 都跑（成本接近零）。
Macro 仅在估算超阈值或手动调用时跑（一次额外 LLM 调用）。

---

## 事件清单

| 事件 | 时机 | Payload |
|---|---|---|
| `compact_messages` | 每个 turn 顶部 | `{ messages, keepRecentTurns, runId, sessionId? }`（`messages` mutable） |
| `vault_read` | `read_tool_result` 调用 | `{ toolCallId, offset, limit, result: { value? } }` |
| `compaction_done` | macro 完成后 | `{ runId, sessionId?, before, after, summary }` |

---

## Public API surface

```ts
// @walle-agent/core
export { partitionByTurns, buildPlaceholder } from "./message-compactor.js";
export type { PartitionResult, PlaceholderInput } from "./message-compactor.js";

export {
  summariseConversation,
  DEFAULT_SUMMARY_PROMPT,
} from "./conversation-summarizer.js";

export { readToolResultTool } from "./builtin-tools/read-tool-result.js";

export type { MacroCompressionConfig } from "./agent-config.js";
// agent.compact() 直接挂在 Agent 类上，无需额外导出
```

---

## 边界 & 兼容

| Case | 行为 |
|---|---|
| 前 1–3 turn | `partitionByTurns` 返回空 `evictableIndices` → no-op。 |
| 已逐出消息 | 重渲染 placeholder 即可；不重复落盘。 |
| Memory 插件未装 | `compact_messages` 无监听 → messages 不变；`read_tool_result` 返回 `{ error }`。 |
| Macro 在 run 中 | `agent.compact()` 抛错；自动触发只在 turn 之间。 |
| 已有 summary user 消息 | 被识别并替换，不堆叠。 |
| Summary 模型调用失败 | 一行 warn，跳过 macro，run 继续。 |

---

## 与现有规格的关系

- 与 [09 — Memory](./09-memory.md) 的 Tool Result Vault 章节合并：09 解释"跨 run 历史回填"，本 spec 解释"当前 run 内 + 主动压缩"。
- 与 [17 — Token Budget](./17-token-budget.md) 互补：TokenBudget 控 ContextItem，本 spec 控 messages。
- 与 [20 — Built-in Tools](./20-builtin-tools.md) 联动：新增 `read_tool_result` 工具。
