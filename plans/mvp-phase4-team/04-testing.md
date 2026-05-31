# Phase 4 — Team Testing

## Unit tests

### `packages/team/tests/sub-agent-tool.test.ts` (9 tests)

**`slugifyToolName`**
- Lowercases and replaces non-alphanumerics with `_` (e.g. `"My Researcher 1"` → `"my_researcher_1"`).
- Preserves hyphens and underscores.
- Trims edge underscores; caps at 60 chars.
- Falls back to `"agent"` when input slugifies to empty.

**`createSubAgentTool`**
- Tool shape: `name = "delegate_<slug>"`, `riskLevel: "low"`, `tags: ["sub-agent"]`, `parameters.required: ["task"]`.
- Slugifies `agent.name` into the tool name.
- `options.name` overrides the auto-generated slug.
- `options.description` overrides the default description.
- `execute({ task })` calls `agent.run(task)` once and returns `{ result: agentResult.content }`.

### `packages/team/tests/blackboard.test.ts` (4 tests)

- `post()` adds a timestamped entry; `getEntries()` returns a defensive copy.
- `renderForAgent` returns the bare task when empty.
- `renderForAgent` prepends prior entries with a "Your Turn" anchor.
- `renderFinal` joins entries by `---`, preserving post order.

### `packages/team/tests/agent-team.test.ts` (12 tests)

**Constructor**
- Throws when `members` is empty.

**Parallel**
- Runs every member concurrently; output contains each member's section header + content.
- Aggregates `toolCalls` / `messages` from every member.

**Pipeline**
- Default order: each member sees prior content; final content = last agent's output.
- Honours `pipelineOrder` override.
- Throws when `pipelineOrder` references an unknown member.

**Debate**
- `maxRounds × members` calls; transcript contains every round.
- With coordinator: returns coordinator content; aggregates rounds + summary telemetry.
- Default `maxRounds = 3` when omitted.

**Supervisor**
- Delegates straight to `coordinator.run`; member agents not invoked.
- Throws when no coordinator is configured (message points at `createSupervisorTeam`).

**Unknown strategy**
- Throws with the bad value in the message.

### `packages/team/tests/swarm.test.ts` (6 tests)

- Constructor rejects empty members list.
- Runs N rounds while `shouldContinue` returns true; posts every output to blackboard.
- Breaks early when `selectAgents` returns `[]`.
- Uses `policy.synthesize` when provided.
- `state.rounds` carries monotonic indices and recorded agents.
- Aggregates messages/toolCalls/events into the final result.

### `packages/team/tests/create-supervisor.test.ts` (4 tests)

Uses a `StubProvider` that emits a single `text_delta` + `message_complete` chunk.

- Coordinator's tool list includes `delegate_<slug>` for every member (verified by inspecting `provider.calls[0].tools`).
- Auto-generated systemPrompt lists every member with `name`, `role`, and `description`; mentions `delegate_*`.
- `coordinator.name` and `coordinator.systemPrompt` overrides honoured.
- Empty `members` rejected.

## Build

- `pnpm --filter @walle-agent/team build` — clean ESM (9.44 KB) + CJS (10.67 KB) + d.ts (8.02 KB).
- `pnpm build` (full monorepo) — clean across 10 packages.

## Full suite

- `pnpm test` — **287 passed (37 files)**, up from 252 before this slice (+35 team tests).

## Manual smoke (recommended)

1. **Pipeline e2e** — wire three real agents (mock provider returning fixed content per member); call `team.run(task, { strategy: "pipeline" })`; confirm last agent's content is the result and each agent's prompt includes the prior stage's content.
2. **Supervisor e2e** — `createSupervisorTeam({ members, coordinator: { model: openai } })`; call with a real model; confirm the coordinator selects `delegate_*` tools and aggregates the sub-agent results.
3. **Swarm round-robin** — define a `SwarmPolicy` that picks one member per round and stops after 3 rounds; confirm blackboard contains 3 entries and `Swarm.run` returns their concatenation.

## Phase 4 status after this slice

```
Phase 4 — Team & Collaboration   ✅ COMPLETE
- [x] Pipeline 模式：Research → Code → Review 流水线执行
- [x] Parallel 模式：多 Agent 并行执行并汇总
- [x] Supervisor 模式：Coordinator 动态分配子任务
- [x] SubAgent 封装为 Tool 可被调用
```
