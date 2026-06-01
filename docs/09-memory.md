# 09 — Memory

## 分层记忆模型

```
┌─────────────────────────────────────────────────┐
│ Short-Term Memory (STM)                         │
│ - 会话消息（user / assistant / tool）            │
│ - 生命周期：一个 sessionId（跨 run 持久）          │
│ - 存储：JSONL（messages.jsonl + runs.jsonl）      │
│ - 注入方式：collect_messages 事件 → conversationHistory │
└─────────────────────────────────────────────────┘
        ↕ 摘要 / 提取（Phase 2.5+）
┌─────────────────────────────────────────────────┐
│ Mid-Term Memory (MTM)                           │
│ - 会话摘要、任务结论、阶段性成果                   │
│ - 生命周期：数天到数周                            │
│ - 存储：JSONL 文件                              │
│ - 注入方式：语义检索 → TokenBudget 裁剪 → prompt │
└─────────────────────────────────────────────────┘
        ↕ 沉淀 / 去重
┌─────────────────────────────────────────────────┐
│ Long-Term Memory (LTM)                          │
│ - 用户偏好、项目事实、稳定知识、可复用经验          │
│ - 生命周期：永久（可编辑/删除）                    │
│ - 存储：memories.jsonl                          │
│ - 注入方式：关键词检索 → collect_context → prompt │
└─────────────────────────────────────────────────┘
```

> **Phase 2 实现范围**：STM（文件化 session log）+ LTM（关键词检索）+ 大 tool result 外溢。
> **MTM** 需要 LLM 摘要，留到 Phase 2.5。
> **Embedding-based 检索** 留到 Phase 3+。

---

## 目录布局

```
./.walle/
  sessions/
    <sessionId>/
      messages.jsonl    # append-only；每行一个 ModelMessage
      runs.jsonl        # append-only；每个 run 的生命周期记录
  memory/
    memories.jsonl              # 长期记忆
    large-tool-results/
      <toolCallId>.txt          # 被外溢的 tool 原始 output
      <toolCallId>.meta.json    # preview / size / evictedAt
```

所有路径都可以在 `MemoryPluginConfig` 里覆盖。

---

## Short-Term Memory：会话日志（file-backed）

与传统 "in-memory buffer" 不同，Walle 的 STM 直接写文件系统。每条消息在产生时立即 append 到 `messages.jsonl`，不等 run 结束：

| 时机                       | 写入                                       |
|----------------------------|--------------------------------------------|
| `onRunStart`               | `runs.jsonl` append `{runId, startAt}`；`messages.jsonl` append 当前 user message |
| `afterModelCall`           | `messages.jsonl` append assistant message   |
| `afterToolCall`（普通）     | `messages.jsonl` append 完整 tool message   |
| `afterToolCall`（超大）     | 先写 `large-tool-results/<id>.txt`，再在 jsonl append 一个 **envelope 占位**（见下） |
| `onRunEnd`                 | `runs.jsonl` append `{runId, endAt, status}`|

**好处**：崩溃不丢；可以 tail -f；另一个进程可以实时读取。

### 注入 history 到 prompt

Runtime 在 `executeGenerator` 中发出 `collect_messages` 事件：

```ts
const history: ModelMessage[] = [];
await this.eventBus.emit("collect_messages", { sessionId, into: history });
// 然后交给 PromptBuilder
messages = this.promptBuilder.build({
  systemPrompt,
  input,
  context: budgetedItems,
  tools,
  conversationHistory: history,   // ← 新增
});
```

`MemoryPlugin` 监听该事件，把 `messages.jsonl` 读进来（按规则回填/摘要 evicted 消息后）推入 `into`。

---

## 大 Tool Result 外溢（eviction）

> **v0.2 update**: 这一节的 size-based 落盘 + envelope 占位机制保留作为兼容入口；
> 在 v0.2 里 `ToolResultVault` 进一步成为 **turn-based micro 压缩**（`compact_messages` 事件 + `read_tool_result` 工具）的后端。
> 完整规格见 [`21-context-compression.md`](./21-context-compression.md)。

Tool call 返回超过阈值（默认 `20000` chars，参考 `deepagents`）的内容时：

1. **当前 run** 内存里的 `messages[]` **保持完整** —— agent 仍需要对结果做推理。
2. **写 `messages.jsonl` 时替换为 envelope**：

   ```ts
   {
     role: "tool",
     toolCallId: call.id,
     content: JSON.stringify({
       _kind: "walle.evicted-tool-result",
       toolCallId, toolName,
       path: "<abs path to .txt>",
       size, preview, evictedAt
     })
   }
   ```
   `preview` = head N 行 + `... [M lines truncated] ...` + tail N 行（默认各 30 行）。

3. **下次 `agent.run()` 再读会话历史**时（由 `collect_messages` 触发），envelope 会被渲染成摘要字符串：

   ```
   Tool result too long. You can read <path> if needed.
   (toolCallId=<id>, tool=<name>, size=<N> chars, evictedAt=<ISO>)

   <preview>
   ```
   这与 deepagents 的 `TOO_LARGE_TOOL_MSG` 语义一致。Agent 可以用 `read_file` 拉具体切片。

### "下一轮" 的定义与 cancel-resume 语义

> **下一轮** = 一个新的 `agent.run()` 且其**前一个** run 的 status **不是** `user-cancelled`。

换句话说，如果用户通过 `AbortSignal.abort()` 中断了一个 run，然后继续发起 run，那么被中断的那次 run 的 tool result 会**完整重新注入**（视为 "同一个思路" 而非新一轮），让 agent 能接着之前的推理继续。更早的 `completed` 的 run 仍然使用摘要。

Runtime 通过 `onRunEnd.status` 将 status 持久化到 `runs.jsonl`。`MemoryPlugin` 在加载 history 时读取 `runs.jsonl` 尾部：

```ts
const lastRun = await sessionLog.lastRun(sessionId, /* excludeRunId = */ currentRunId);
const lastCancelledRunId =
  lastRun?.status === "user-cancelled" ? lastRun.runId : undefined;

// 加载消息：
for (const rec of records) {
  if (rec.runId === currentRunId) continue;         // 当前 run 已经在 PromptBuilder 里
  const envelope = tryDecodeEviction(msg.content);
  if (envelope) {
    const full = rec.runId === lastCancelledRunId
      ? await vault.readFull(envelope.toolCallId)   // 完整还原
      : vault.formatSummary(envelope);              // 摘要
    push({ ...msg, content: full ?? vault.formatSummary(envelope) });
  } else {
    push(msg);
  }
}
```

---

## Memory Plugin

```ts
export interface MemoryPluginConfig {
  /** 所有 artefact 的根目录。默认 `./.walle`。 */
  rootDir?: string;

  sessions?: {
    enabled?: boolean;      // 默认 true
    dir?: string;           // 默认 <rootDir>/sessions
  };

  largeToolResults?: {
    enabled?: boolean;      // 默认 true
    dir?: string;           // 默认 <rootDir>/memory/large-tool-results
    thresholdChars?: number;  // 默认 20000
    previewHeadLines?: number;// 默认 30
    previewTailLines?: number;// 默认 30
  };

  longTerm?: {
    enabled?: boolean;      // 默认 true
    filePath?: string;      // 默认 <rootDir>/memory/memories.jsonl
    topK?: number;          // 默认 8
    dedupThreshold?: number;// 默认 0.8（Jaccard）
  };
}

export class MemoryPlugin implements WallePlugin {
  name = "memory";
  readonly manager: MemoryManager;        // 长期记忆 API
  readonly sessionLog?: SessionLog;       // 会话日志
  readonly vault?: ToolResultVault;       // 大 tool result 外溢

  async install(ctx: AgentContext): Promise<void> {
    // 注册 remember / recall / forget 三个 tool
    for (const tool of buildRememberTools(this.manager)) ctx.registerTool(tool);

    // 注册 hooks：onRunStart / afterModelCall / afterToolCall / onRunEnd / onRunError
    //   → 写 session log + 视需要 evict tool result
    // 注册事件：collect_messages（注入 history）、collect_context（注入 LTM）
  }
}
```

---

## MemoryItem（LTM）

```ts
export type MemoryScope = "short" | "mid" | "long";

export type MemoryType =
  | "fact"
  | "preference"
  | "summary"
  | "procedure"
  | "profile"
  | "decision"
  | "warning";

export interface MemoryItem {
  id: string;
  scope: MemoryScope;
  type: MemoryType;
  content: string;
  importance: number;  // 0..1
  confidence: number;  // 0..1
  userId?: string;
  sessionId?: string;
  tags?: string[];
  createdAt: string;
  updatedAt?: string;
  expiresAt?: string;  // 留给 MTM
  source?: {
    conversationId?: string;
    messageIds?: string[];
    toolCallIds?: string[];
  };
}
```

---

## MemoryManager（LTM）

```ts
export class MemoryManager {
  readonly store: MemoryStore;   // FileMemoryStore by default

  async remember(input: RememberInput): Promise<MemoryItem> {
    // 1) 在同 scope + type 下，按 Jaccard >= dedupThreshold 查近似
    // 2) 命中 → update（取长内容、confidence/importance 取 max、合并 tags）
    // 3) 未命中 → put
  }

  async retrieve(query: string, options?): Promise<MemoryItem[]> {
    // store.search({ text: query, scope: "long", topK })
  }

  async forget(id: string): Promise<boolean>;
  async list(options?): Promise<MemoryItem[]>;
}
```

---

## MemoryStore 接口

```ts
export interface MemoryStore {
  init(): Promise<void>;
  put(item: MemoryItem): Promise<void>;
  get(id: string): Promise<MemoryItem | undefined>;
  update(id: string, patch: Partial<MemoryItem>): Promise<void>;
  delete(id: string): Promise<void>;
  search(query: MemoryQuery): Promise<MemoryItem[]>;
  list(options?: { scope?: MemoryScope; limit?: number; offset?: number }): Promise<MemoryItem[]>;
}

export interface MemoryQuery {
  text?: string;
  scope?: MemoryScope;
  types?: MemoryType[];
  userId?: string;
  sessionId?: string;
  topK?: number;
}
```

---

## FileMemoryStore（默认实现）

JSONL 文件；`put` append，`update/delete` rewrite；`search` 为关键词评分（`keywordScore * 0.6 + jaccard * 0.4`）+ 可选 scope/type/userId/sessionId 过滤；空 query 按 `createdAt` 倒序。

```ts
export class FileMemoryStore implements MemoryStore {
  // ... 见 packages/memory/src/file-memory-store.ts
}
```

---

## `remember` / `recall` / `forget` 工具

插件注册三个 builtin 工具给 LLM：

| 工具        | 描述                                                   | riskLevel |
|-------------|--------------------------------------------------------|-----------|
| `remember`  | 写入 LTM（自动去重合并）                                | low       |
| `recall`    | 关键词检索 LTM                                          | low       |
| `forget`    | 按 id 删除，需审批                                      | medium    |

工具的 prompt 描述参考 deepagents 的 memory guidelines，引导 LLM 在用户明确要求/隐含表达长期偏好时才写入，而不是把临时请求也记下来。

---

## ShortTermMemory（in-memory 辅助类，可选）

Phase 1 预留的纯内存实现保留着，供不需要持久化的场景：

```ts
export class ShortTermMemory {
  private messages: ModelMessage[] = [];
  add(message: ModelMessage): void;
  getMessages(): ModelMessage[];
  clear(): void;
}
```

默认 MemoryPlugin 不使用它，而是直接用 `SessionLog` 写磁盘。

---

## 与 Evolution 的集成

Evolution 插件（后续 branch）通过 `ctx.getPlugin("memory").manager` 拿到 `MemoryManager`，把"显式 Remember 检测"/"周期性 review"产生的 `MemoryProposal` 转成 `remember()` 调用。
