# Support `interrupt` / `resume` — Testing

## Unit / integration tests

All tests stay within the existing pnpm+vitest setup; no network / real LLM.

### `packages/core/tests/interrupt-resume.test.ts`

- **auto-sessionId-default**
  - `Agent.create({ name, model })` ⇒ `agent.sessionId` is a non-empty string.
  - `Agent.create({ sessionId: "fixed" })` ⇒ `agent.sessionId === "fixed"`.

- **auto-sessionId-threads-through-runs**
  - With a spy plugin that records `collect_messages`' `sessionId`, calling `agent.run("x")` delivers `agent.sessionId` to the event.
  - Calling `agent.run("x", { sessionId: "other" })` delivers the override.

- **interrupt-idle-noop**
  - Freshly-created agent: `agent.interrupt()` does not throw, no state change.

- **interrupt-during-stream**
  - MockProvider yields one text delta, then awaits indefinitely.
  - In parallel, `await Promise.resolve(); agent.interrupt();`
  - Stream emits `run_end` with `status: "user-cancelled"`.

- **concurrent-run-throws**
  - Start `agent.run("a", { stream: true })`, but don't iterate.
  - Calling `agent.run("b")` throws with a helpful message.

- **dispose-interrupts**
  - Start a streaming run against an infinite MockProvider.
  - Call `agent.dispose()`.
  - The stream emits `run_end.status === "user-cancelled"`; no hang.

### `packages/memory/tests/resume.integration.test.ts`

- **resume-requires-memory**
  - `Agent.resume("sid", { name, model })` throws.

- **resume-requires-existing-session**
  - `Agent.resume("unknown", { name, model, plugins: [new MemoryPlugin({rootDir})] })` throws with the session path in the error.

- **resume-roundtrip**
  - Create agent w/ memory. Run "remember A". Call `Agent.resume(agent.sessionId, config)`. Next `run("anything")` sees the prior user + assistant messages in `LLMChatRequest.messages`.

- **resume-after-interrupt-rehydrates-full-tool-output**
  - Same as Phase-2 integration scenario C, but triggered via `agent.interrupt()` instead of an external `AbortController`:
    1. Run #1: tool returns 4000-char string, then `agent.interrupt()` before the follow-up model call.
    2. Resume via `Agent.resume(sid, config)`.
    3. Run #2: assert the tool message in the LLM request is the **full** string (not the summary).

## Regression

- All existing Phase-1 + Phase-2 tests keep passing.
- `pnpm -r build` type-checks clean (new surface on `Agent`).

## Manual

- `examples/interrupt-resume.ts` with `.env` pointing at OpenAI-compatible endpoint:

```bash
pnpm --filter walle-agent-examples run interrupt-resume
# ... emit "interrupting" midway via Ctrl-C; sessionId printed at exit.
SESSION_ID=<id> pnpm --filter walle-agent-examples run interrupt-resume
# ... continues.
```
