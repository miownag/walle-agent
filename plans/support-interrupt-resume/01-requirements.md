# Support `interrupt` / `resume` — Requirements

## Goal

Give Agents a first-class, user-visible way to:

1. **Interrupt** the currently running loop (e.g. user hit Ctrl-C in a CLI) — instance method `agent.interrupt()`.
2. **Resume** a prior conversation — static method `Agent.resume(sessionId, config)` that re-creates an agent wired to an existing session and re-hydrates history from the memory filesystem.

Both build on top of the Phase-2 memory primitives (`messages.jsonl`, `runs.jsonl`, cancel-aware history rehydration that is already shipped). No new storage.

## Trigger

User wants:

> Agent 应该支持 interrupt 和 resume（静态方法）两个方法
> 1. interrupt 打断当前 loop，一般用于用户主动打断
> 2. resume 即 Agent.resume(sessionId) 可以继续会话，其本质是从 memory 文件系统加载会话历史构建上下文，然后新建一个 agent，把整个上下文发给它，就实现了"继续"，因此应该在 Agent.create 时应同步生成一个 session id 暴露出去

## Acceptance Criteria

### `Agent.create` changes
- [x] `Agent.create(config)` always assigns a `sessionId`. If the caller didn't provide `config.sessionId`, a UUID is generated.
- [x] The new `sessionId` is exposed as `agent.sessionId: string` (read-only).
- [x] Every `agent.run(input)` automatically threads `sessionId` into the run — no need to pass it explicitly. Caller can still override via `run(input, { sessionId })`.
- [x] `AgentConfig.sessionId?: string` accepted so callers can pin a specific id.

### `agent.interrupt()`
- [x] Instance method. Aborts the currently-in-flight run (if any).
- [x] Internally trips the run's `AbortController`, same path as passing an external `signal`.
- [x] The aborted run surfaces `run_end` with `status: "user-cancelled"` (no new behaviour — MemoryPlugin already depends on this).
- [x] No-op when nothing is running; safe to call repeatedly.
- [x] Optional `reason?: string` is recorded in the run-end event for observability, but the status remains `user-cancelled` (matches "user-initiated abort").
- [x] `interrupt()` does not throw on the caller; the run generator surfaces the abort cleanly.

### `Agent.resume(sessionId, config)`
- [x] Static method. Signature: `Agent.resume(sessionId: string, config: Omit<AgentConfig, "sessionId">): Promise<Agent>`.
- [x] Under the hood: equivalent to `Agent.create({ ...config, sessionId })`, so memory plugin loads prior history on the next `run()`.
- [x] Throws if `MemoryPlugin` is not in `config.plugins` (resume without memory has no meaning).
- [x] Throws if the session directory does not exist (loud failure is better than silently starting a fresh conversation the user thinks is resumed).
- [x] After `resume`, calling `agent.run("next thing")` automatically injects prior history via `collect_messages`.
- [x] If the most-recent prior run was `user-cancelled`, its evicted tool results rehydrate to full content — this is already implemented; resume just exercises that code path.

### Concurrency / misc
- [x] Concurrent `agent.run()` calls are not supported (Phase-1 implicit assumption stays). The second call gets a descriptive error.
- [x] `agent.interrupt()` resolves the in-flight run's `run_end`; subsequent `agent.run()` can be called after.
- [x] `dispose()` also interrupts any in-flight run before disposing plugins.

## Non-Goals

- No pause-and-continue within a single run. "Interrupt" is terminal for the current run.
- No cross-process resume (sessions are local-fs only in Phase 2).
- No concurrent multi-run per agent.
- No partial replay (pick-up-mid-tool-call). Resume re-runs the next prompt; the cancel-rehydration rule already handles "continuing the same thought".
