# Phase 2 — Evolution Testing Plan

## Strategy

Two layers, matching the memory slice conventions:

1. **Unit tests** — hit each class (`ProposalFileStore`, `EvolutionEngine`,
   `SkillRegistry`) with a tmp dir. No LLM. `MockProvider` returns scripted
   JSON for extraction prompts.
2. **Integration tests** — full `Agent.create(...)` with Memory + Skills +
   Evolution installed. `MockProvider` splits traffic: `stream(...)` serves
   the agent run, `chat(...)` serves evolution extraction calls.

All tests run under `vitest` via `pnpm test`. Vitest already globs `packages/**`.

---

## Unit tests

### `packages/skills/tests/skill-registry.test.ts` (5)

- Loads persisted skills on init.
- `register` in-memory + persisted to disk.
- Full skill catalog is injected on every `collect_context`; items contain name + description only, never the body.
- Usage metadata (`usageCount` / `lastUsedAt`) increments when the `skill` tool is invoked successfully.
- `remove` wipes from memory + disk.

### `packages/evolution/tests/proposal-file-store.test.ts` (4)

- `enqueue` assigns id + createdAt + status=pending.
- `list({ status })` filters; returned in FIFO order.
- `approve` / `reject` / `markApplied` transition status.
- `delete` removes the file.

### `packages/evolution/tests/evolution-engine.test.ts` (9)

- `explicit_remember`: extracts a memory and auto-applies (default requireApproval=false).
- `explicit_remember`: gates filter out sub-threshold proposals.
- `explicit_remember`: `requireApproval=true` enqueues without applying.
- `periodic_review` fires only on the Nth run.
- `task_review` proposes a skill when tool-call count ≥ minToolCalls.
- `task_review` + `requireApproval=true` enqueues without registering.
- `approvalHandler` returning `true` applies without queueing.
- Malformed JSON is tolerated (no proposals extracted).
- Fenced ```json``` blocks are parsed correctly.

---

## Integration tests

### `packages/evolution/tests/evolution-plugin.integration.test.ts` (5)

All integration tests use a tmp `rootDir` and a `MockProvider` that splits:
- `stream(...)` → `runResponses[]` (agent turn)
- `chat(...)` → `evolResponses[]` (evolution extraction, non-streaming)

Because evolution runs fire-and-forget in `onRunEnd`, tests use a small
`waitForCondition` helper to poll until the side-effect lands.

1. **Explicit remember → memory auto-applied**
   - Run asks "remember pnpm"; evolution extraction returns a preference memory.
   - After run, `memoryPlugin.manager.list()` contains the memory.
2. **Periodic review fires on Nth run**
   - `everyTurns=3`. Verify `mp.chatCalls.length === 0` after 2 runs.
   - After 3rd run, memory is extracted and applied.
3. **Task review proposes a skill**
   - 3 tool calls in a run. Skill extraction returns a prompt skill.
   - `skillsPlugin.registry.list()` has exactly one skill, `createdBy === "agent"`.
4. **Fails fast when MemoryPlugin missing**
   - `Agent.create` with only `EvolutionPlugin` → rejects with `/MemoryPlugin/`.
5. **`approveAndApply` writes queued memory into LTM**
   - `memoryCreation.requireApproval=true`. After run, 1 item in `pending()`.
   - `memoryPlugin.manager.list()` still empty.
   - After `approveAndApply`, memory is stored; proposal status is `applied`.

---

## Build / type verification

```bash
pnpm -r build
  ✓ @walle-agent/core
  ✓ @walle-agent/openai
  ✓ @walle-agent/anthropic
  ✓ @walle-agent/memory
  ✓ @walle-agent/skills     — new
  ✓ @walle-agent/evolution  — new
```

```bash
pnpm test   # 145/145 passing (was 118 before; 18 new in evolution, 5 in skills, no regressions)
```

## Manual regression

```bash
pnpm basic
pnpm stream
pnpm memory
pnpm evolution   # new
```

Expected behaviour from `pnpm evolution`:

1. Run 1: `"Please remember: I use pnpm, never npm."` → agent replies; after a
   short background delay, the memory is stored on disk at
   `./.walle-evolution/memory/memories.jsonl`.
2. Run 2: `"Which package manager should I use?"` → agent recalls the memory
   via `collect_context` and answers "pnpm".
3. Prints any pending proposals (skills require approval by default).

## Regression matrix

| Scenario | Status |
|----------|--------|
| Phase 1 core integration tests (10/10) | must pass |
| Phase 2 memory integration tests (6/6) | must pass |
| Phase 2 memory cancel-resume tests (3/3) | must pass |
| All 7 existing tests in memory unit suite | must pass |
| `onRunEnd` hook still fires for users that ignore `messages` | must pass |
| Evolution plugin with no skills plugin → `taskReview` no-ops, other triggers still work | must pass |
| Evolution plugin with `requireApproval=true` + no `approvalHandler` → proposals queued, nothing applied | must pass |

All green at last run.
