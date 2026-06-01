# Context Compression — Design

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│ @walle-agent/core                                                        │
│                                                                          │
│  AgentConfig                                                             │
│   ├─ macroCompression?: MacroCompressionConfig   ← new                   │
│   └─ ...                                                                 │
│                                                                          │
│  events.ts                                                               │
│   AgentEventMap += {                                                     │
│     compact_messages: { messages, keepRecentTurns, runId, sessionId },   │
│     compaction_done:  { runId, sessionId, before, after, summary },      │
│   }                                                                      │
│                                                                          │
│  message-compactor.ts                ← new (pure)                        │
│   ├─ partitionByTurns(messages, keepRecentTurns)                         │
│   │   → { protectedTail, evictable }                                     │
│   ├─ buildPlaceholder(env): string                                       │
│   └─ rewriteToolMessage(msg, env, fmt): ModelMessage                     │
│                                                                          │
│  conversation-summarizer.ts          ← new (pure)                        │
│   ├─ buildSummaryPrompt(messages, opts): ModelMessage[]                  │
│   ├─ MacroCompressionInput / Result                                      │
│   └─ summarize(model, messages, opts): Promise<string>                   │
│                                                                          │
│  agent-runtime.ts (update)                                               │
│   executeGenerator():                                                    │
│     for turn:                                                            │
│       emit compact_messages   ← NEW (memory plugin rewrites tail)        │
│       maybeMacroCompact()     ← NEW (turn-between only, opt-in)          │
│       model.stream(...)                                                  │
│       ... existing ...                                                   │
│                                                                          │
│  agent.ts (update)                                                       │
│   ├─ async compact(opts?): Promise<CompactionResult>                     │
│   └─ runtime exposed via getRuntime() (existing internal hook)           │
│                                                                          │
│  builtin-tools/read-tool-result.ts   ← new                               │
│   └─ readToolResultTool                                                  │
│       parameters: { toolCallId, offset?, limit? }                        │
│       execute(): emits "vault_read" event; memory plugin returns content │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│ @walle-agent/memory                                                      │
│                                                                          │
│  ToolResultVault (extend)                                                │
│   ├─ thresholdChars: number  (default 0 — "always evict to disk")        │
│   ├─ index.jsonl  (append-only: { idx, toolCallId, toolName, ts, size }) │
│   └─ readSlice(toolCallId, offset, limit): {content,totalLines,trunc}    │
│                                                                          │
│  memory-plugin.ts (extend)                                               │
│   install(ctx):                                                          │
│     ctx.events.on("compact_messages", rewriteTail)                       │
│     ctx.events.on("vault_read",       respondReadSlice)                  │
│   rewriteTail(payload):                                                  │
│     1. Use partitionByTurns(messages, keepRecentTurns).                  │
│     2. For each evictable tool message: ensure vault has the content,    │
│        rewrite content to placeholder text.                              │
│   respondReadSlice(payload):                                             │
│     vault.readSlice(...) → payload.result                                │
└──────────────────────────────────────────────────────────────────────────┘
```

## Module layout

```
packages/core/src/
├── message-compactor.ts             new — pure turn partitioning helpers
├── conversation-summarizer.ts       new — pure summary prompt + run helper
├── events.ts                        update — add compact_messages, compaction_done, vault_read
├── agent-config.ts                  update — add macroCompression field
├── agent.ts                         update — add agent.compact()
├── agent-runtime.ts                 update — emit compact_messages each turn; macro check
└── builtin-tools/
    ├── read-tool-result.ts          new
    └── index.ts                     update — export & include in BUILTIN_TOOLS

packages/memory/src/
├── tool-result-vault.ts             update — index.jsonl, readSlice, threshold semantics
├── memory-plugin.ts                 update — listen compact_messages + vault_read; expose memoryRoot
├── memory-types.ts                  update — toolResults config (deprecate largeToolResults)
└── ...
```

## 1. Turn partitioning (pure)

```ts
// packages/core/src/message-compactor.ts

import type { ModelMessage } from "./message.js";

export interface PartitionResult {
  /** indices in messages[] to keep verbatim — system + most recent N turns */
  keepIndices: Set<number>;
  /** indices that may have their tool message bodies replaced */
  evictableIndices: Set<number>;
  /** turn boundaries from oldest to newest */
  turnStarts: number[];
}

/**
 * Partition by **assistant turn**: each `role: "assistant"` message starts a turn.
 * The most recent `keepRecentTurns` (default 3) assistant turns and the messages
 * after them are kept verbatim. System / user messages preceding the oldest
 * kept turn are still kept (system always; user becomes evictable for macro).
 *
 * For micro: only `role: "tool"` messages within evictable region are rewritten.
 */
export function partitionByTurns(
  messages: ModelMessage[],
  keepRecentTurns: number,
): PartitionResult { /* ... */ }
```

### Algorithm

1. Walk `messages` left → right; record `turnStarts[i]` for every `role: "assistant"` index.
2. `cutoff = turnStarts[max(0, turnStarts.length - keepRecentTurns)]`.
3. `keepIndices` = `{ i | i >= cutoff }` ∪ `{ i | role === "system" }`.
4. `evictableIndices` = complement.

For first 3 turns there's nothing to evict — fast path returns early.

## 2. Placeholder text (pure)

```ts
// packages/core/src/message-compactor.ts (cont.)

export interface PlaceholderInput {
  idx: number;
  toolName: string;
  toolCallId: string;
  size: number;
  vaultPath?: string;
  preview: string;
}

export function buildPlaceholder(p: PlaceholderInput): string {
  const lines = [
    `[ToolResult #${p.idx} evicted | tool=${p.toolName} | toolCallId=${p.toolCallId} | size=${p.size} chars]`,
    p.vaultPath
      ? `Use read_tool_result(toolCallId="${p.toolCallId}") or read_file(path="${p.vaultPath}") to load the full content.`
      : `Use read_tool_result(toolCallId="${p.toolCallId}") to load the full content.`,
    "",
    p.preview,
  ];
  return lines.join("\n");
}
```

## 3. Vault upgrades

```ts
// packages/memory/src/tool-result-vault.ts (extends)

class ToolResultVault {
  thresholdChars: number;          // default 0 → always evict
  /** Monotonic counter; persisted via index.jsonl */
  private nextIdx = 1;

  /** New: ensures the content is on disk and returns the placeholder envelope. */
  async ensure(params: {
    toolCallId: string;
    toolName: string;
    content: string;
    status?: ToolStatus;
  }): Promise<EvictedToolResult & { idx: number }>;

  /** New: pagination read. */
  async readSlice(toolCallId: string, opts: { offset?: number; limit?: number }):
    Promise<{ content: string; totalLines: number; truncated: boolean }>;
}
```

`ensure()` semantics:

- If `<dir>/<toolCallId>.txt` exists → reuse, increment idx only on first ensure (look up via `index.jsonl`).
- Else → write file + meta + append `{ idx, toolCallId, toolName, ts, size }` to `index.jsonl`.
- Returns envelope (with `idx`).

`thresholdChars: 0` ⇒ ensure always lands on disk. `> 0` ⇒ short outputs stay in-message; only those exceeding the threshold are evicted.

## 4. Memory plugin: compact_messages handler

```ts
// packages/memory/src/memory-plugin.ts (excerpt)

ctx.events.on("compact_messages", async (payload) => {
  if (!this.vault) return;

  const { messages, keepRecentTurns } = payload;
  const part = partitionByTurns(messages, keepRecentTurns);

  for (const i of part.evictableIndices) {
    const msg = messages[i];
    if (msg.role !== "tool") continue;

    // Already evicted? Decode envelope from content for placeholder.
    let envelope = tryDecodeEviction(msg.content);
    if (!envelope) {
      // Live content — write to disk and rewrite.
      const raw = typeof msg.content === "string" ? msg.content : "";
      if (this.vault.thresholdChars > 0 && raw.length <= this.vault.thresholdChars) {
        continue; // short output, keep verbatim per config
      }
      const ev = await this.vault.ensure({
        toolCallId: msg.toolCallId!,
        toolName: msg.metadata?.toolName ?? "unknown",
        content: raw,
        status: msg.metadata?.status,
      });
      envelope = ev;
    }

    messages[i] = {
      ...msg,
      content: buildPlaceholder({
        idx: envelope.idx,
        toolName: envelope.toolName,
        toolCallId: envelope.toolCallId,
        size: envelope.size,
        vaultPath: envelope.path,
        preview: envelope.preview,
      }),
    };
  }
});
```

> **Tool name on tool messages**: today the runtime pushes `{ role: "tool", toolCallId, content }` without `toolName`. We extend `ModelMessage` to carry an optional `metadata?: { toolName?: string; status?: string }` so the vault knows the original name without lookup. Backward-compat: optional field, no consumer breaks.

## 5. read_tool_result tool

```ts
// packages/core/src/builtin-tools/read-tool-result.ts

export const readToolResultTool: Tool<
  { toolCallId: string; offset?: number; limit?: number },
  { content: string; totalLines: number; truncated: boolean } | { error: string }
> = defineTool({
  name: "read_tool_result",
  description:
    "Read the full content of an evicted tool result by its toolCallId. " +
    "Use offset/limit to paginate large outputs.",
  parameters: {
    type: "object",
    properties: {
      toolCallId: { type: "string" },
      offset: { type: "number" },
      limit: { type: "number" },
    },
    required: ["toolCallId"],
  },
  riskLevel: "low",
  tags: ["builtin"],
  async execute(input, ctx) {
    const result: { value?: unknown } = {};
    await (ctx.agent as any).getEventBus?.()?.emit?.("vault_read", {
      toolCallId: input.toolCallId,
      offset: input.offset ?? 0,
      limit: input.limit ?? 200,
      result,
    });
    if (!result.value) {
      return { error: "tool result vault not available — install @walle-agent/memory" };
    }
    return result.value as any;
  },
});
```

> Note: agent context already exposes `agent.getEventBus()` (added internally for plugins). If not, we add a minimal `agent.runtime.events` accessor here.

## 6. Macro compression

### 6.1 Summary prompt

```ts
// packages/core/src/conversation-summarizer.ts

export const DEFAULT_SUMMARY_PROMPT = `\
You are summarising a conversation between a user and an AI agent so the agent \
can continue with limited context. Preserve:
1. The user's overall goal and constraints
2. Key facts/decisions made
3. Outstanding tasks or pending questions
4. Any tool call ids / file paths the agent may need to reference later
5. Errors or warnings the agent should remember

Output: a markdown bulleted summary, ≤ 800 tokens. Do not invent facts.

<conversation>
{{messages}}
</conversation>`;

export interface SummariseInput {
  model: LLMProvider;
  messages: ModelMessage[];        // the messages to compress
  promptTemplate?: string;
  signal?: AbortSignal;
}

export async function summariseConversation(
  input: SummariseInput,
): Promise<string> {
  const prompt = (input.promptTemplate ?? DEFAULT_SUMMARY_PROMPT)
    .replace("{{messages}}", renderMessagesForSummary(input.messages));
  const stream = input.model.stream({
    messages: [{ role: "user", content: prompt }],
    signal: input.signal,
  });
  let buf = "";
  for await (const chunk of stream) {
    if (chunk.type === "text_delta") buf += chunk.content;
    if (chunk.type === "message_complete") {
      return chunk.message.content as string;
    }
  }
  return buf;
}
```

### 6.2 Runtime integration

```ts
// agent-runtime.ts inside executeGenerator
for (let turn = 0; turn < maxTurns; turn++) {
  // 1. Micro pass
  await this.eventBus.emit("compact_messages", {
    messages, keepRecentTurns, runId, sessionId,
  });

  // 2. Macro check (between turns only, not mid-stream)
  if (this.config.macroCompression?.enabled
      && !this.config.macroCompression.manualOnly) {
    const estTokens = estimateTokens(messages);
    const max = this.tokenBudget.maxContextTokens;
    if (estTokens > max * (this.config.macroCompression.threshold ?? 0.8)) {
      await this.runMacroCompact(messages, sessionId, runId);
    }
  }

  // 3. Existing model.stream() call ...
}
```

`runMacroCompact()`:

1. Use `partitionByTurns(messages, keepRecentTurns)` to find protected tail.
2. `head` = system messages + everything older than the tail; `tail` = the protected tail (already micro-compressed).
3. `summary = await summariseConversation({ model: summaryModel, messages: head })`.
4. Replace `messages` in place: `[systemMsgs..., {role:"user", content:`[Summary of N earlier messages]\n${summary}`}, ...tail]`.
5. Emit `compaction_done` event.
6. If `MemoryPlugin` is installed, write to `<sessionDir>/summaries/<runId>-<idx>.md` and append `{ kind: "compaction", path, beforeMsgCount, afterMsgCount }` to `runs.jsonl`.

### 6.3 agent.compact()

```ts
// agent.ts (excerpt)

async compact(options?: { keepRecentTurns?: number; summaryModel?: LLMProvider }) {
  if (this.runtime.isRunning()) {
    throw new Error("Agent.compact() cannot run while a run is in flight.");
  }

  // Load latest history via collect_messages event into a synthetic array.
  const messages: ModelMessage[] = [];
  await this.runtime.eventBus.emit("collect_messages", {
    sessionId: this.sessionId, into: messages,
  });

  const before = messages.length;
  const beforeTokens = estimateTokens(messages);
  await this.runtime.runMacroCompact(messages, this.sessionId, /* runId */ "manual", options);
  const afterTokens = estimateTokens(messages);
  return {
    summary: extractLastSummary(messages),
    beforeMessages: before,
    afterMessages: messages.length,
    beforeTokens,
    afterTokens,
    droppedMessages: before - messages.length,
  };
}
```

> **Persistence note**: `agent.compact()` materialises a "summary checkpoint" the *next* run sees. Implementation: write `summaries/<sessionId>/<ts>.md` and an entry into `runs.jsonl` with `{ kind: "compaction", appliesToRunsBefore: <runId>, summaryPath }`. `MemoryPlugin.collect_messages` honours that — drop messages from older runs, inject the summary as a single user message at that boundary.

## 7. Token estimation

Reuse `TokenBudget`'s simple heuristic — promote it to `core/src/token-estimate.ts`:

```ts
export function estimateTokens(content: string | ModelMessage[]): number;
```

For now: 4 chars / token (English-leaning); 1.5 chars / token for `[一-鿿]` block. Provider-accurate counting deferred.

## 8. Public API surface

```ts
// @walle-agent/core
export { partitionByTurns, buildPlaceholder } from "./message-compactor.js";
export { summariseConversation, DEFAULT_SUMMARY_PROMPT } from "./conversation-summarizer.js";
export type { MacroCompressionConfig } from "./agent-config.js";
export { readToolResultTool } from "./builtin-tools/read-tool-result.js";

// @walle-agent/memory
export { ToolResultVault } from "./tool-result-vault.js";    // already exported
// new readSlice surface available via plugin event handler — no new public type
```

## 9. Backward compat

- `MemoryPluginConfig.largeToolResults` continues to be parsed (alias for `toolResults`); a `console.warn` runs once per process when the legacy field is detected.
- Default `keepRecentTurns = 3`, `thresholdChars = 0` ⇒ behaviour change: previously short outputs stayed in-message; now they go to disk too. We mitigate by keeping the placeholder text identical (size=N is small → no real cost) **only for evictable region**; recent 3 turns still see full content.
- Macro is **opt-in** (default `enabled: false`).
- `read_tool_result` is added to `BUILTIN_TOOLS`; users who pin tools via `useBuiltinTools.includeTools` need to add it to read evicted results.

## 10. Conflict / edge cases

| Case | Behaviour |
|---|---|
| First 1–3 turns | `partitionByTurns` returns empty `evictableIndices` → no-op. |
| Tool message inside protected tail | Stays verbatim. |
| Tool message already an evicted envelope | Re-render placeholder with `buildPlaceholder` using existing `vault.readEnvelope`. |
| `compact_messages` emitted but memory not installed | No listeners → messages untouched (graceful degrade). |
| `agent.compact()` while running | Throws `Error("Agent.compact() cannot run while a run is in flight.")`. |
| Macro on conversation with no model summary support | Use parent model; if model errors, swallow and skip (one log line, no run break). |
| Re-compact the same conversation | Idempotent — already-summarised user message is detected by sentinel `[Summary of N earlier messages]` and replaced, not stacked. |
