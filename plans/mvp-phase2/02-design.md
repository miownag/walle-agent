# Phase 2 — Memory Design

This document is the design for the **Memory** slice of Phase 2. Skills and Evolution will ship in later iterations and are only sketched here.

Spec references:
- `docs/09-memory.md` — the layered memory model (STM/MTM/LTM).
- `docs/03-core-runtime.md` — execution loop + EventBus.
- `docs/12-hooks-middleware.md` — hooks, middleware ordering.
- `docs/18-roadmap.md` — Phase 2 position.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ @walle-agent/memory                                                │
│                                                                    │
│  MemoryPlugin                                                      │
│   ├─► SessionLog               (per-sessionId JSONL, append-only)  │
│   │    └─ records every ModelMessage + run boundaries              │
│   │                                                                │
│   ├─► ToolResultVault          (./.walle/memory/large-tool-results)│
│   │    └─ writes oversized outputs to .txt, returns stub metadata  │
│   │                                                                │
│   ├─► MemoryManager            (long-term knowledge)               │
│   │    ├─ FileMemoryStore      (JSONL, append + rewrite on mutate) │
│   │    ├─ keyword retrieval    (Jaccard + tag overlap)             │
│   │    └─ dedup + forget                                           │
│   │                                                                │
│   └─► Tools:                                                       │
│         remember / recall / forget                                 │
│                                                                    │
│  Hooks it registers:                                               │
│   • onRunStart  → open run, decide "next turn vs. resume"          │
│   • afterModelCall → append assistant message to SessionLog        │
│   • afterToolCall  → evict if oversized, append tool message       │
│   • onRunEnd    → close run with status                            │
│                                                                    │
│  Events it registers on:                                           │
│   • collect_messages → inject prior session messages               │
│   • collect_context  → inject LTM retrieval                        │
└────────────────────────────────────────────────────────────────────┘
```

### Core-runtime changes (minimal)

Adds two concepts to `@walle-agent/core`:

1. **`collect_messages` event.** Parallel to `collect_context`, but for full prior `ModelMessage[]` (conversation history) rather than snippets. Plugins implement it; runtime merges results.
2. **Run lifecycle metadata.** `run_start` / `run_end` payloads expose `runId`, `sessionId`, and `status` (`completed | user-cancelled | error`). Runtime computes `status` from the generator outcome + `AbortSignal`.

Everything else lives in the memory package.

---

## Directory layout

```
./.walle/
  sessions/
    <sessionId>/
      messages.jsonl    # append-only; one ModelMessage per line (with _meta)
      runs.jsonl        # append-only; one run lifecycle record per line
  memory/
    memories.jsonl            # long-term memory items
    large-tool-results/
      <toolCallId>.txt        # evicted tool output (raw)
      <toolCallId>.meta.json  # preview, size, evictedAt, toolName
```

All paths are configurable on `MemoryPluginConfig`.

---

## Data shapes

```ts
// Session log — one JSONL line per message
interface SessionMessageRecord {
  runId: string;
  turn: number;               // index within the run
  timestamp: string;          // ISO
  message: ModelMessage;      // may contain an evicted tool stub
}

// Session log — one JSONL line per run boundary
interface SessionRunRecord {
  runId: string;
  sessionId: string;
  startAt: string;
  endAt?: string;
  status?: "completed" | "user-cancelled" | "error";
  error?: string;
}

// Tool-result eviction stub — stored inline inside ModelMessage.content for evicted tool messages
interface EvictedToolResult {
  _kind: "walle.evicted-tool-result";
  toolCallId: string;
  toolName: string;
  path: string;          // absolute path to .txt
  size: number;          // chars
  preview: string;       // head+tail preview
  evictedAt: string;
}

// Long-term memory
interface MemoryItem {
  id: string;
  scope: "long";         // "short" / "mid" reserved for future
  type: "fact" | "preference" | "summary" | "procedure" | "profile" | "decision" | "warning";
  content: string;
  importance: number;    // 0..1
  confidence: number;    // 0..1
  userId?: string;
  sessionId?: string;
  tags?: string[];
  createdAt: string;
  updatedAt?: string;
  source?: { conversationId?: string; messageIds?: string[]; toolCallIds?: string[] };
}
```

The message on disk for a non-evicted tool result is a normal `ModelMessage`. For an evicted one, we **rewrite** only the tool-result content to an envelope:

```ts
{
  role: "tool",
  toolCallId: call.id,
  content: JSON.stringify({
    _kind: "walle.evicted-tool-result",
    toolCallId, toolName, path, size, preview, evictedAt
  })
}
```

On rehydration the reverse of this is what happens.

---

## Tool-result eviction — lifecycle in detail

```
run N starts
 ├─ session history is loaded (see "Loading history")
 ├─ ... turns ...
 │   tool X returns a 12KB string
 │    ├─ runtime builds full tool message  (in-memory  ← full content)
 │    ├─ MemoryPlugin.afterToolCall intercepts the record
 │    │   • if len(output) > threshold:
 │    │     – write file ./.walle/memory/large-tool-results/<id>.txt
 │    │     – construct stub envelope (path, preview, size)
 │    │     – append the *stub* envelope to session messages.jsonl
 │    │   • else:
 │    │     – append the full tool message to session messages.jsonl
 │    └─ the in-memory `messages[]` (used by the next LLM call in the SAME run)
 │       keeps the full content, untouched.
 │
 └─ run N ends  → runs.jsonl gets status="completed"

run N+1 starts  (sessionId identical, status of N != user-cancelled)
 ├─ MemoryPlugin.collect_messages loads messages.jsonl
 │    • for each evicted stub → render as summarized tool message:
 │        "Tool result too long. You can read <path> if needed.\n<preview>"
 │    • non-evicted messages load as-is
 ├─ PromptBuilder interleaves { system, context, history, current-user-input }
 └─ LLM proceeds

run N cancelled by user (AbortSignal), then user re-invokes
 ├─ runs.jsonl for N has status="user-cancelled"
 ├─ MemoryPlugin.collect_messages notices the prior run was cancelled
 │    and rehydrates evicted stubs to full content for the cancelled run
 │    only (older completed runs still summarize).
 └─ This matches the "same thought, not a new turn" semantics.
```

Why the in-memory `messages[]` keeps full content for the current run: the agent already has this content loaded into context and we don't want to force the agent to immediately re-read its own tool results from disk. The eviction only matters for *future* runs.

### Preview format

`preview` = first 30 lines + separator + last 30 lines (configurable). Skipped middle becomes `... [N lines truncated] ...`.

### Summarized tool-result template

```
Tool result too long. You can read {path} if needed.
(toolCallId={id}, tool={name}, size={size} chars, evictedAt={timestamp})

{preview}
```

This matches the deepagents `TOO_LARGE_TOOL_MSG` pattern and tells the agent exactly how to fetch slices using `read_file` (which already supports `startLine` / `endLine`).

---

## Loading history (`collect_messages`)

New EventBus event:

```ts
interface AgentEventMap {
  // existing ...
  collect_messages: { sessionId?: string; into: ModelMessage[] };
}
```

`AgentRuntime.executeGenerator`:

```
1. normalize input
2. if sessionId:
     history: ModelMessage[] = []
     await eventBus.emit("collect_messages", { sessionId, into: history })
3. contextItems = await collectContext(...)
4. messages = promptBuilder.build({
     systemPrompt, input, context: budgetedItems, tools,
     conversationHistory: history
   })
5. loop...
```

`MemoryPlugin` listens and loads from `messages.jsonl`. Rehydration rule is:

```
for each record in messages.jsonl (in order):
  if record.message.role === "tool" and content is an EvictedToolResult envelope:
    if record.runId == lastCancelledRunId:
       content = fs.readFileSync(evicted.path)     # full
    else:
       content = formatSummary(evicted)            # stub string
  push record.message
```

`lastCancelledRunId` is determined by reading the tail of `runs.jsonl`; if the very last run before the current one has `status="user-cancelled"`, that id is used.

### Writing lifecycle

| Moment                           | Writer                  | Record                                    |
|----------------------------------|-------------------------|-------------------------------------------|
| `onRunStart`                     | `runs.jsonl` append     | `{ runId, startAt }`                       |
| user message normalized          | `messages.jsonl` append | `{ runId, turn:0, message: userMessage }` |
| `afterModelCall`                 | `messages.jsonl` append | assistant message                          |
| `afterToolCall` (normal)         | `messages.jsonl` append | tool message (full)                        |
| `afterToolCall` (oversized)      | write vault + append    | tool message (stub envelope)               |
| `onRunEnd` (status=completed)    | `runs.jsonl` append     | close record                                |
| `onRunError`                     | `runs.jsonl` append     | `status=error`                              |
| `AbortSignal.aborted`            | `onRunEnd` path         | `status=user-cancelled`                    |

All writes go through a serialized `SessionLog.append()` to avoid interleaving on concurrent turns (we don't expect concurrency but we'll guard with a `Promise` queue just in case).

---

## Long-term memory

Unchanged from the existing `docs/09-memory.md` design, with three new tools:

```ts
// registered by MemoryPlugin
remember: { content, type?, tags?, importance? } → MemoryItem
recall:   { query, topK?, types? }                → MemoryItem[]
forget:   { id }                                  → { deleted: boolean }
```

Retrieval is via `collect_context` listener — identical to the spec. No behavioural changes.

---

## MemoryPlugin public API

```ts
import { MemoryPlugin } from "@walle-agent/memory";

const agent = await Agent.create({
  name: "Walle",
  model: ...,
  plugins: [
    new MemoryPlugin({
      rootDir: "./.walle",                 // default
      sessions: {
        enabled: true,                      // default
      },
      largeToolResults: {
        enabled: true,                      // default
        thresholdChars: 20000,              // default (matches deepagents)
        previewHeadLines: 30,
        previewTailLines: 30,
      },
      longTerm: {
        enabled: true,                      // default
        topK: 8,
      },
    }),
  ],
});

// Sessions are addressed via sessionId on run()
await agent.run("What did we talk about yesterday?", { sessionId: "user-42" });
```

The plugin also exposes a `manager` handle on `AgentContext` (`ctx.getPlugin("memory").manager`) so Evolution / user code can call `remember/forget/list` programmatically.

---

## File inventory (this branch)

New:

- `packages/memory/package.json`
- `packages/memory/tsup.config.ts`
- `packages/memory/tsconfig.json`
- `packages/memory/src/index.ts`
- `packages/memory/src/memory-plugin.ts`
- `packages/memory/src/memory-manager.ts`
- `packages/memory/src/memory-types.ts`
- `packages/memory/src/file-memory-store.ts`
- `packages/memory/src/session-log.ts`
- `packages/memory/src/tool-result-vault.ts`
- `packages/memory/src/remember-tools.ts`
- `packages/memory/src/similarity.ts`
- `packages/memory/tests/session-log.test.ts`
- `packages/memory/tests/tool-result-vault.test.ts`
- `packages/memory/tests/memory-manager.test.ts`
- `packages/memory/tests/memory-plugin.integration.test.ts`
- `examples/memory.ts`

Modified in core (small additive surface, no breaking change):

- `packages/core/src/events.ts`      — add `collect_messages` event type.
- `packages/core/src/stream.ts`      — extend `RunStartEvent` / `RunEndEvent` with `runId`, `sessionId`, `status?`.
- `packages/core/src/hooks.ts`       — `onRunEnd` payload gains `status`.
- `packages/core/src/prompt-builder.ts` — already supports `conversationHistory`; wire it from runtime.
- `packages/core/src/agent-runtime.ts` — emit `collect_messages`, track run status, propagate `AbortSignal`.
- `packages/core/src/index.ts`       — re-exports.

Modified root:

- `package.json` → add memory build script (nothing needed thanks to `-r`).
- `pnpm-workspace.yaml` already globs `packages/*`.
- `plans/mvp-phase2/01-requirements.md` (done).
- This file.
- `plans/mvp-phase2/03-tasks.md`, `04-testing.md`.

---

## Key design decisions & trade-offs

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Session storage format | Append-only JSONL per session | Crash-safe; easy to inspect; simple mental model; matches project default storage (`docs/18-roadmap.md`). |
| Full-vs-stub in-memory | Current run keeps full, future runs see stub | Agent needs full payload to reason on the turn that *produced* it; future turns can pull slices via `read_file`. Matches deepagents. |
| "Next turn" definition | New `agent.run()` that did not follow a `user-cancelled` run | Matches the user's intent: resuming from cancel should feel like continuing the same thought. |
| Eviction threshold unit | Characters | Cheap, no tokenizer dep in `core`. Evolution can later swap to token count if needed. |
| LTM retrieval | Keyword Jaccard + tag overlap | Zero external deps; good enough for MVP; replaceable behind `MemoryStore` interface. |
| LTM dedup | Jaccard > 0.8 on content words, same type+scope | Same as `docs/09-memory.md`. |
| `collect_messages` vs. `collect_context` | Separate event | `context` items go *inside* the system message; history goes *between* system and user. Conflating them would force encoding history as plain text. |
| Run status source of truth | Runtime owns it | Plugin would have to introspect AsyncGenerator state otherwise. |

---

## Follow-ups (not in this branch)

- Skills package (`@walle-agent/skills`).
- Evolution package (`@walle-agent/evolution`) — consumes `afterModelCall`/`afterToolCall`, uses `MemoryManager` programmatically.
- Mid-term memory (summaries) — requires an LLM-backed summarizer (Phase 2.5).
- Optional embedding-based retrieval behind the `MemoryStore` interface (Phase 3+).
