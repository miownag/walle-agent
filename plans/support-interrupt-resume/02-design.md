# Support `interrupt` / `resume` — Design

## Big picture

Phase 2's `MemoryPlugin` + `SessionLog` already does all the heavy lifting:

- Every `ModelMessage` is persisted to `messages.jsonl` on write.
- Every run's lifecycle is persisted to `runs.jsonl` with `status`.
- `collect_messages` rehydrates history on the next run.
- `AbortSignal.aborted` already maps to `run_end.status = "user-cancelled"`.

So this branch is a thin ergonomics layer on top:

| Feature              | Hooks into existing mechanism                                              |
|----------------------|----------------------------------------------------------------------------|
| `agent.interrupt()`  | An internal `AbortController` the runtime creates per run, composed with `options.signal`. |
| `Agent.resume(id,c)` | Just `Agent.create({...c, sessionId: id})` with a validation guard.        |
| Auto `sessionId`     | Move UUID generation from "maybe, if you pass one" to "always, exposed on the Agent." |

## Session id lifetime

```
Agent.create({ ... })
  │
  ├─ sessionId = config.sessionId ?? crypto.randomUUID()
  ├─ agent.sessionId = sessionId          ← publicly readable
  └─ runtime remembers sessionId as the default for every run()

agent.run("hi")                             → uses agent.sessionId
agent.run("hi", { sessionId: "override" }) → uses override; does NOT mutate agent.sessionId
```

`MemoryPlugin` already writes to `./.walle/sessions/<sessionId>/...` — with auto-assigned ids, every agent now has a session from birth.

## `interrupt()` wiring

The runtime already threads `options.signal` all the way down:

```
run()/stream()  ──► executeGenerator(input, options)
                    ├─ signal = options?.signal
                    └─ each turn checks signal.aborted
```

We compose a private controller:

```ts
// in runtime, per-run
const internalController = new AbortController();
this.activeRun = { id: runId, controller: internalController };

const signal = mergeSignals(options?.signal, internalController.signal);
// thread `signal` everywhere we used options?.signal
```

`mergeSignals` is a tiny helper that listens on both and aborts the returned one if either fires.

Then:

```ts
agent.interrupt(reason?: string): void {
  const active = this.runtime.activeRun;
  if (!active) return;                      // no-op when idle
  active.controller.abort(reason ?? "user-interrupt");
}
```

The generator's existing `if (userCancelled()) { status = "user-cancelled"; return; }` checks pick it up at the next await point and the `finally` emits `run_end`.

### Concurrent run guard

Runtime was implicitly single-run. Now that we're tracking `activeRun`, make it explicit:

```ts
if (this.activeRun) {
  throw new Error(
    `Agent "${this.name}" is already running (runId=${this.activeRun.id}). ` +
    `Call agent.interrupt() before starting a new run.`
  );
}
```

This is set at the top of `executeGenerator` and cleared in `finally` (alongside the existing status logic).

## `Agent.resume(sessionId, config)`

Pure helper:

```ts
static async resume(
  sessionId: string,
  config: Omit<AgentConfig, "sessionId">,
): Promise<Agent> {
  // 1. Find the MemoryPlugin
  const memory = config.plugins?.find((p) => p.name === "memory") as MemoryPlugin | undefined;
  if (!memory) {
    throw new Error(
      "Agent.resume requires a MemoryPlugin in config.plugins; " +
      "otherwise there is no storage to resume from."
    );
  }

  // 2. Verify the session exists on disk
  const root = memory.rootDir;
  const sessionDir = path.join(root, "sessions", sessionId);
  if (!existsSync(sessionDir)) {
    throw new Error(`Agent.resume: session "${sessionId}" not found at ${sessionDir}`);
  }

  return Agent.create({ ...config, sessionId });
}
```

To make this check possible, `MemoryPlugin` needs to expose `rootDir` (public readonly).
Also exposes `sessionDir(sessionId: string): string` for convenience / testability.

## `dispose()` also interrupts

To avoid dispose leaking a running generator:

```ts
async dispose(): Promise<void> {
  this.interrupt("agent-dispose");
  // existing plugin.dispose() loop
}
```

## File inventory

Modified:

- `packages/core/src/agent-config.ts`
  - `AgentConfig.sessionId?: string`
  - `ResolvedAgentConfig.sessionId: string` (always present)
  - `resolveConfig` assigns a UUID if missing.
- `packages/core/src/agent.ts`
  - `readonly sessionId: string` on Agent.
  - `interrupt(reason?)` method.
  - Static `Agent.resume(sessionId, config)`.
  - `dispose()` calls `interrupt` first.
- `packages/core/src/agent-runtime.ts`
  - Track `activeRun = { id, controller }`.
  - Compose internal + external `AbortSignal`.
  - Thread agent.sessionId as default `input.sessionId`.
  - Concurrent run guard.
- `packages/core/src/signal-utils.ts` (new, tiny) — `mergeAbortSignals(...signals)`.
- `packages/core/src/index.ts` — no new public exports besides the new method.
- `packages/memory/src/memory-plugin.ts`
  - `readonly rootDir: string`.
  - `sessionDir(sessionId): string` helper.

New tests:

- `packages/core/tests/interrupt-resume.test.ts`
  - `agent.interrupt()` during a pending `stream()` produces `run_end { status: "user-cancelled" }`.
  - `agent.interrupt()` while idle is a no-op.
  - `Agent.resume` errors without memory plugin.
  - `Agent.resume` errors on unknown sessionId.
  - `Agent.resume` succeeds → next run sees prior history.
  - Concurrent `agent.run()` throws.
  - `dispose()` interrupts an in-flight run.

New example:

- `examples/interrupt-resume.ts` (hello-world; Ctrl-C then `pnpm resume`-style pattern).

## Risk + mitigation

| Risk | Mitigation |
|------|------------|
| `mergeAbortSignals` listener leaks | `AbortSignal.any()` is in Node 20+, we can use it directly; if unavailable, we attach + detach with `addEventListener({ once: true })`. |
| Abort race with `finally` emitting `run_end` | Existing code already relies on the same pattern for externally-supplied signals; no new race. |
| Auto sessionId surprises users who don't want persistence | `MemoryPlugin` is still opt-in. Without it, SessionLog never writes; `sessionId` is just a label. |
| Resume with stale config (different systemPrompt etc.) | Honest — the new config wins. Document it. |
