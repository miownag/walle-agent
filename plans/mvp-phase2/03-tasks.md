# Phase 2 — Memory Tasks

Ordered implementation checklist. Each task maps to one logical commit.

---

## T1 — Core runtime surface (additive, non-breaking)

- [ ] `packages/core/src/events.ts` — add `collect_messages: { sessionId?: string; into: ModelMessage[] }`.
- [ ] `packages/core/src/stream.ts`:
  - Extend `RunStartEvent` → `{ type:"run_start"; input; runId; sessionId? }`.
  - Extend `RunEndEvent` → `{ type:"run_end"; runId; sessionId?; status:"completed"|"user-cancelled"|"error"; error? }`.
- [ ] `packages/core/src/hooks.ts`:
  - `onRunStart` payload gains `runId`, `sessionId?`.
  - `onRunEnd` payload gains `runId`, `sessionId?`, `status`, `error?`.
- [ ] `packages/core/src/agent-runtime.ts`:
  - Generate `runId` per `run()` / `stream()`.
  - Pass `AbortSignal` down into tool execution context (it already accepts one; just wire options.signal).
  - On generator finally: compute `status` — `user-cancelled` if `signal.aborted`, `error` if thrown, else `completed`.
  - Emit `run_start` / `run_end` with new fields.
  - Before history-free context collection, emit `collect_messages` and collect prior history.
  - Feed `conversationHistory` to `PromptBuilder.build`.
- [ ] `packages/core/src/prompt-builder.ts` — already has `conversationHistory`; no change needed.
- [ ] `packages/core/src/index.ts` — re-export updated types.
- [ ] Tests:
  - `packages/core/tests/integration.test.ts` (existing) keeps passing.
  - Add a unit test for the new `collect_messages` path in `packages/core/tests/event-bus.test.ts` or a new `packages/core/tests/run-lifecycle.test.ts`.

## T2 — New `@walle-agent/memory` package scaffold

- [ ] Create `packages/memory/` with `package.json`, `tsconfig.json`, `tsup.config.ts`, `src/index.ts`.
- [ ] `peerDependencies: { "@walle-agent/core": "workspace:*" }`; `devDependencies` for typescript + tsup + vitest + `@walle-agent/core`.
- [ ] `tsup.config.ts` externalises `@walle-agent/core`, emits ESM+CJS+DTS.
- [ ] `pnpm install`; verify build passes before writing code.

## T3 — Data types

- [ ] `packages/memory/src/memory-types.ts`:
  - `EvictedToolResult` envelope.
  - `SessionMessageRecord`, `SessionRunRecord`.
  - `MemoryItem`, `MemoryQuery`, `MemoryScope`, `MemoryType`.

## T4 — `SessionLog`

- [ ] `packages/memory/src/session-log.ts`:
  - `appendMessage(record)` / `appendRun(record)` serialized via a promise-chain queue.
  - `readAll(sessionId): Promise<{ messages: SessionMessageRecord[]; runs: SessionRunRecord[] }>`.
  - Ensures directories exist; creates files on first append.
  - Exposes `lastCancelledRunId(sessionId)` helper.
- [ ] Unit tests (`tests/session-log.test.ts`):
  - append → readAll round-trip.
  - interleaved appends remain ordered.
  - lastCancelledRunId behaviour with mixed statuses.

## T5 — `ToolResultVault`

- [ ] `packages/memory/src/tool-result-vault.ts`:
  - `evict(toolCallId, toolName, fullContent): Promise<EvictedToolResult>`.
  - Writes `<id>.txt` + `<id>.meta.json`; builds preview (configurable head/tail).
  - `read(toolCallId): Promise<string>` for rehydration.
  - `formatSummary(envelope, { baseDirRelative })` producing the prompt-ready string.
- [ ] Unit tests:
  - eviction → file on disk.
  - preview head/tail produces expected ellipsis marker for content > head+tail lines.
  - read returns same content.

## T6 — `FileMemoryStore`

- [ ] `packages/memory/src/file-memory-store.ts`:
  - JSONL-backed LTM store (mirrors `docs/09-memory.md` snippet).
  - `put` appends; `update`/`delete` rewrite.
  - `search` uses the similarity util for scoring + filters.
- [ ] `packages/memory/src/similarity.ts` — Jaccard over lowercased word-sets; exported for tests.
- [ ] Unit tests:
  - put → get → list round-trip with persistence across instances.
  - search ranks by keyword overlap; honours `scope` / `types` / `userId` filters.
  - update + delete both reflected in the JSONL on disk.

## T7 — `MemoryManager`

- [ ] `packages/memory/src/memory-manager.ts`:
  - Wraps `FileMemoryStore`.
  - `remember`, `forget`, `list`, `retrieve`.
  - Dedup via similarity threshold.
- [ ] Unit tests:
  - `remember` dedups near-duplicates (merges, bumps confidence).
  - `retrieve` returns top-K by score.

## T8 — `remember` / `recall` / `forget` tools

- [ ] `packages/memory/src/remember-tools.ts` — builders that close over a `MemoryManager` and return `Tool[]` via `defineTool`.
- [ ] Tools:
  - `remember`: `{ content, type?, tags?, importance? }` → created/merged item.
  - `recall`: `{ query, topK?, types? }` → items.
  - `forget`: `{ id }`.

## T9 — `MemoryPlugin`

- [ ] `packages/memory/src/memory-plugin.ts`:
  - `install(ctx)`:
    - Resolve paths, instantiate `SessionLog`, `ToolResultVault`, `MemoryManager`.
    - Register `remember / recall / forget` tools.
    - Register hooks: `onRunStart`, `afterModelCall`, `afterToolCall`, `onRunEnd`, `onRunError`.
    - Register event listeners: `collect_messages`, `collect_context`.
    - Expose `(ctx as any).__memoryManager = manager` + `this.manager`.
  - `dispose()` flushes & closes log writers.
- [ ] Tracks in-memory per-run state (runId → first-user-message logged, turn counter) using a `WeakMap<Agent, RunState>` or plugin-level Map keyed by runId.

## T10 — Integration test

- [ ] `packages/memory/tests/memory-plugin.integration.test.ts` — uses the existing `MockProvider` pattern from `packages/core/tests/mock-provider.ts`:
  - Scenario A: session round-trip. Run #1 has a 2-turn conversation, run #2 with the same sessionId sees the prior messages.
  - Scenario B: tool-result eviction. Tool returns a huge string; run #1 continues with full content; in run #2 the stored message is summarized + has the file path.
  - Scenario C: cancel-and-resume. Run #1 aborts mid-tool; run #2 sees the full content (not summarized) for the cancelled run's tool results, then summarized for any earlier completed runs.
  - Scenario D: LTM retrieval. `remember` via tool → next run's `collect_context` surfaces the item for a related query.

## T11 — Example & build

- [ ] `examples/memory.ts` — reuses the `.env`-driven provider like `examples/thinking.ts`. Demonstrates:
  1. `agent.run("Remember that I prefer TypeScript", { sessionId })`
  2. `agent.run("What language do I prefer?", { sessionId })`
- [ ] `examples/package.json` — add `memory` script.
- [ ] `pnpm -r build` passes.
- [ ] `pnpm test` passes.

## T12 — Spec update

- [ ] Update `docs/09-memory.md`:
  - Mark STM as "file-backed JSONL session log" in Phase 2 (clarify the previous "in-memory" wording).
  - Add the "Tool-result eviction" section with the envelope + summary template.
  - Note the `collect_messages` event alongside `collect_context`.
- [ ] Update `docs/03-core-runtime.md` — add `collect_messages` to the event list + run-status field.
- [ ] Update `docs/18-roadmap.md` — mark Memory slice of Phase 2 as in-progress/complete after ship.

---

## Out-of-band follow-ups (NOT this branch)

- Skills package (`T-S*` tasks in a future plan).
- Evolution package (`T-E*`).
- Mid-term summary memory (requires LLM call; defer until we have a summarizer utility).
