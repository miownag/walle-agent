# Context Compression — Testing

> 全部用 Vitest + mock LLMProvider；不接真模型。所有 spec 与 03-tasks.md 的 T-* 编号一一对应。

## A1 — Token estimator

**File**: `packages/core/tests/token-estimate.test.ts`

- `estimateTokens("hello world")` ≈ 3。
- `estimateTokens("中文测试")` ≈ 3 (1.5 chars/token)。
- `estimateTokens([{role:"user", content: "..."}])` 等于各消息 content 之和 + 小常数 overhead。
- 与原 TokenBudget 私有实现行为一致（snapshot 旧实现在 PR 前先固化）。

## A2 — `partitionByTurns` / `buildPlaceholder`

**File**: `packages/core/tests/message-compactor.test.ts`

```ts
describe("partitionByTurns", () => {
  it("returns empty evictable when fewer turns than keep", () => {
    const msgs = mk([
      sys(), user(), asst("a"), tool(), asst("b"), tool(),
    ]);
    const r = partitionByTurns(msgs, 3);
    expect(r.evictableIndices.size).toBe(0);
  });

  it("evicts older turns, keeps the last N assistant turns + system", () => {
    const msgs = mk([
      sys(), user(),
      asst("a1"), tool(),    // turn 1
      asst("a2"), tool(),    // turn 2
      asst("a3"), tool(),    // turn 3
      asst("a4"), tool(),    // turn 4 (newest)
    ]);
    const r = partitionByTurns(msgs, 3);
    // index 0 system kept; user index 1 evictable; turns 2..3 evictable
    expect(r.keepIndices.has(0)).toBe(true);
    expect(r.evictableIndices.has(2)).toBe(true);
    expect(r.evictableIndices.has(3)).toBe(true);
    expect(r.keepIndices.has(8)).toBe(true); // turn 4 asst
    expect(r.keepIndices.has(9)).toBe(true); // turn 4 tool
  });
});

describe("buildPlaceholder", () => {
  it("contains idx, tool name, toolCallId, size, hint, preview", () => {
    const out = buildPlaceholder({
      idx: 5, toolName: "bash", toolCallId: "abc",
      size: 12345, vaultPath: "/tmp/abc.txt", preview: "PREVIEW",
    });
    expect(out).toContain("[ToolResult #5 evicted");
    expect(out).toContain("toolCallId=abc");
    expect(out).toContain("size=12345 chars");
    expect(out).toContain("read_tool_result(toolCallId=\"abc\")");
    expect(out).toContain("/tmp/abc.txt");
    expect(out).toContain("PREVIEW");
  });
});
```

## A3 — `summariseConversation`

**File**: `packages/core/tests/conversation-summarizer.test.ts`

```ts
it("calls model with rendered messages and returns summary text", async () => {
  const calls: ModelCallArgs[] = [];
  const model = mockProviderEcho(async (args) => {
    calls.push(args);
    return [
      { type: "text_delta", content: "- bullet 1\n- bullet 2" },
      { type: "message_complete", message: { role: "assistant", content: "- bullet 1\n- bullet 2" }, toolCalls: [] },
    ];
  });
  const summary = await summariseConversation({
    model,
    messages: [user("hi"), asst("hello")],
  });
  expect(summary).toBe("- bullet 1\n- bullet 2");
  expect(calls[0].messages[0].content).toContain("Preserve:");
  expect(calls[0].messages[0].content).toContain("hi");
});

it("respects custom promptTemplate with {{messages}}", async () => { /* ... */ });
it("forwards signal", async () => { /* ... */ });
```

## A4 — Event types

**File**: `packages/core/tests/events.test.ts`（已存在；扩展）

- `compact_messages` 监听器收到 mutable `messages` 引用，可 in-place 修改。
- `compaction_done` payload 形状校验。
- `vault_read` `payload.result.value` 写入后 emit 返回。

## A5 — Macro config resolve

**File**: `packages/core/tests/agent-config.test.ts`

- 不传 `macroCompression` ⇒ resolved 字段为 null。
- 传 `{ enabled: true }` ⇒ 默认值正确填充（threshold=0.8, keepRecentTurns=3, manualOnly=false）。
- `summaryPrompt` / `summaryModel` 透传。

## A6 — ModelMessage metadata

**File**: `packages/core/tests/agent-runtime.test.ts`（扩展）

- 跑一次工具调用，断言 messages 数组中 tool message 含 `metadata.toolName === <call.name>` 且 `metadata.status === "success"`。
- 失败工具：`metadata.status === "error"`。

## B1 — `read_tool_result` tool

**File**: `packages/core/tests/builtin-tools/read-tool-result.test.ts`

- 注册 builtin → `agent.tools` 含 `read_tool_result`。
- 用 spy 监听 `vault_read`，模拟写入 `result.value = { content: "...", totalLines: 3, truncated: false }`，断言 tool execute 返回该值。
- 无监听者 → 返回 `{ error: "tool result vault not available …" }`。
- `useBuiltinTools: { excludeTools: ["read_tool_result"] }` ⇒ tool 不注册。

## B2 — `Agent.getEventBus`

- 私有但可访问；snapshot tests 不必，单元测试通过 `(agent as any).getEventBus()` 可访问 EventBus 实例 instanceof。

## C1 — Vault: idx + readSlice

**File**: `packages/memory/tests/tool-result-vault.test.ts`（扩展）

- `ensure(...)` 第一次写文件 + meta + index.jsonl，返回 `idx === 1`。
- 第二次相同 toolCallId → 不重写文件，返回相同 `idx`。
- `readSlice("id", { offset: 0, limit: 5 })` 返回前 5 行；`totalLines` 正确；`truncated === true` 当总行 > 5。
- `thresholdChars: 0` ⇒ `shouldEvict` 总是 true。
- 路径穿越：`toolCallId = "../etc/passwd"` 被 sanitize（已有逻辑保留）。

## C2 — `MemoryPluginConfig.toolResults` 兼容

**File**: `packages/memory/tests/memory-plugin.test.ts`（扩展）

- 旧 `largeToolResults` 与新 `toolResults` 等价；同时传 → 新覆盖旧。
- 单进程内只 `console.warn` 一次（用 `vi.spyOn(console, "warn")` 断言调用 ≤ 1）。

## C3 — `compact_messages` 监听器

**File**: `packages/memory/tests/memory-plugin.compact.test.ts`（新建）

```ts
it("rewrites tool messages outside the recent N turns", async () => {
  const { agent, runtime, plugin } = await mkAgent({ memory: { /* default */ } });
  const messages = [
    sys("you are walle"),
    user("hi"),
    asst("a1"), tool("id1", "X".repeat(50)),
    asst("a2"), tool("id2", "Y".repeat(50)),
    asst("a3"), tool("id3", "Z".repeat(50)),
    asst("a4"), tool("id4", "W".repeat(50)),
  ];
  await runtime.eventBus.emit("compact_messages", {
    messages, keepRecentTurns: 3, runId: "r1", sessionId: "s1",
  });
  expect(messages[3].content).toContain("[ToolResult #");  // turn1 tool evicted
  expect(messages[5].content).toContain("[ToolResult #");  // turn2 tool evicted
  expect(messages[7].content).not.toContain("[ToolResult #"); // turn3 kept
  expect(messages[9].content).not.toContain("[ToolResult #"); // turn4 kept
});

it("re-renders existing envelopes idempotently", async () => { /* … */ });
it("respects thresholdChars > 0 to keep small outputs verbatim", async () => { /* … */ });
```

## C4 — `vault_read` 监听器

**File**: `packages/memory/tests/memory-plugin.vault-read.test.ts`（新建）

- 触发 `vault_read` → `payload.result.value === { content, totalLines, truncated }`。
- 未知 toolCallId → `{ error: "tool result not found" }`。

## C5 — Always-evict on afterToolCall

**File**: `packages/memory/tests/memory-plugin.test.ts`（扩展）

- `thresholdChars: 0` ⇒ 任意大小的 tool 输出在落盘后 `messages.jsonl` 行内是 envelope（已有断言扩展）。

## D1 — Runtime emits `compact_messages`

**File**: `packages/core/tests/agent-runtime.compact.test.ts`（新建）

- mock provider 返回连续 4 次 tool call → 4 turns。
- 断言：每个 turn 顶部都 emit 了 `compact_messages`，payload `messages` 是当前 messages 引用。

## D2 — Macro auto-check

**File**: `packages/core/tests/agent-runtime.macro.test.ts`（新建）

- 配置 `macroCompression: { enabled: true, threshold: 0.01 }` + 小 `maxContextTokens: 1000`，强制立即触发。
- 断言：在第 2 个 turn 调用 model 之前，messages 数组被压缩（含 `[Summary of N earlier messages]` user 消息）。
- `manualOnly: true` ⇒ 不自动触发。
- `enabled: false` ⇒ 不触发。

## D3 — `runMacroCompact` 行为

- in-place mutation；保留 system + 最近 3 轮；`compaction_done` 事件 emit。
- 已有 summary user 消息 → 不堆叠（替换而非新增）。

## D4 — `Agent.compact()` API

**File**: `packages/core/tests/agent-compact.test.ts`（新建）

- run 中调 `agent.compact()` → throws `Error`。
- 多轮历史调 `agent.compact()` → 返回 `{ summary, beforeTokens, afterTokens, droppedMessages > 0 }`。
- 不传 `summaryModel` → 用 `agent.model`。

## D5 — Persistent compaction log

**File**: `packages/memory/tests/memory-plugin.compaction.test.ts`（新建）

- 触发 `compaction_done` → `summaries/<runId>-<ts>.md` 生成；`runs.jsonl` 含 `{ kind: "compaction", path, ... }`。
- 下次 `collect_messages` → 检测到 compaction 并按规则裁剪 + 插入摘要 user 消息。

## E — Docs

- 不覆盖代码；通过 `pnpm lint` + manual review。

## F — Verification

- `pnpm test` 全绿。
- `pnpm -F @walle-agent/core test --coverage`：`message-compactor.ts` / `conversation-summarizer.ts` ≥ 90%；`agent-runtime.ts` 新增分支 ≥ 80%。
- `pnpm -F @walle-agent/memory test --coverage`：`tool-result-vault.ts` 新增分支 ≥ 90%。
- `pnpm build` 通过（核心：`@walle-agent/core` dist 含 `message-compactor.js` / `conversation-summarizer.js` / `read-tool-result.js`）。

## Mock helpers (shared)

- `mockProviderEcho(stepFn)`：注入一个 `LLMProvider`，其 `stream()` yield 由 stepFn 决定。
- `mk(mfns)`：`(...mkFn[]) => ModelMessage[]`，简洁构造 messages。
- `sys/user/asst/tool`：单条消息工厂。
