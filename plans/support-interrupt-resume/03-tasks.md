# Support `interrupt` / `resume` — Tasks

## T1 — Auto sessionId on `Agent.create`

- [ ] `packages/core/src/agent-config.ts`
  - Add `sessionId?: string` to `AgentConfig`.
  - Make `ResolvedAgentConfig.sessionId: string` required.
  - `resolveConfig` assigns `config.sessionId ?? crypto.randomUUID()`.
- [ ] `packages/core/src/agent.ts`
  - `readonly sessionId: string` set from resolved config.
- [ ] Thread into runtime: `agent-runtime.ts` uses `config.sessionId` as the default when `input.sessionId` / `options.sessionId` are absent (still overridable).

## T2 — `signal-utils.ts` + internal AbortController per run

- [ ] New file `packages/core/src/signal-utils.ts`:
  - Export `mergeAbortSignals(...signals): AbortSignal` (prefer `AbortSignal.any` when available; fall back to a polyfill that listens with `{ once: true }`).
- [ ] `agent-runtime.ts`
  - Private field `activeRun: { id: string; controller: AbortController } | null = null`.
  - In `executeGenerator`:
    - Throw if `activeRun` is already set (concurrent run guard).
    - Create a fresh `AbortController`; set `activeRun`.
    - `signal = mergeAbortSignals(options?.signal, internalController.signal)`.
    - Thread that merged signal to the `userCancelled()` helper and to `executeToolCall`.
    - Clear `activeRun = null` in `finally`.

## T3 — `agent.interrupt(reason?)`

- [ ] `packages/core/src/agent.ts`:
  - `interrupt(reason?: string): void`. Pulls `runtime.activeRun?.controller.abort(...)`.
  - No-op when idle.
- [ ] `AgentRuntime`: expose `activeRun` (readonly accessor) or a dedicated `requestInterrupt(reason?)` that's called from `Agent.interrupt`.
- [ ] `Agent.dispose()` calls `interrupt("agent-dispose")` first.

## T4 — `Agent.resume(sessionId, config)`

- [ ] `packages/core/src/agent.ts`:
  - Static `resume(sessionId, config)`:
    - Look up `memory` plugin by name from `config.plugins`.
    - If missing, throw a descriptive error.
    - Check `sessionDir(sessionId)` exists on disk (call into the memory plugin's public helper).
    - Return `Agent.create({ ...config, sessionId })`.

## T5 — Memory plugin public surface

- [ ] `packages/memory/src/memory-plugin.ts`:
  - Add `readonly rootDir: string` (computed in constructor).
  - Add `sessionDir(sessionId: string): string` helper (joins `<rootDir>/sessions/<id>`).
  - Keep existing behaviour untouched.

## T6 — Tests

- [ ] `packages/core/tests/interrupt-resume.test.ts` (uses local MockProvider pattern):
  - T6.1 `agent.sessionId` auto-assigned UUID; overridable.
  - T6.2 `interrupt()` on idle agent is a no-op.
  - T6.3 `interrupt()` during a streaming run → `run_end.status === "user-cancelled"`.
  - T6.4 Concurrent `agent.run()` throws.
  - T6.5 `dispose()` interrupts a running generator.
- [ ] `packages/memory/tests/resume.integration.test.ts`:
  - T6.6 `Agent.resume` without memory plugin throws.
  - T6.7 `Agent.resume` with unknown session throws.
  - T6.8 `Agent.resume` with existing session + new run → prompt contains prior history.
  - T6.9 Interrupt in run #1 → Resume in run #2 → cancelled run's evicted tool result rehydrates to full (uses rule already covered by integration scenario C in Phase 2).

## T7 — Example + script

- [ ] `examples/interrupt-resume.ts` illustrating:
  1. Create agent, print `agent.sessionId`.
  2. Run a long-ish prompt; attach SIGINT handler that calls `agent.interrupt()`.
  3. After abort, exit printing the sessionId.
  4. Second script run with the sessionId env var uses `Agent.resume(...)` to continue.
- [ ] `examples/package.json` script `interrupt-resume`.

## T8 — Spec updates

- [ ] `docs/03-core-runtime.md` — add `interrupt` / `resume` to the Agent section + mention auto sessionId.
- [ ] `docs/09-memory.md` — brief note that resume is built-in.
- [ ] `docs/18-roadmap.md` — Phase 2 checklist pickups.

## T9 — Build + test

- [ ] `pnpm -r build` clean.
- [ ] `pnpm test` all green.
