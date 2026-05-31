# Phase 4 — Team Tasks

## Done

- [x] `packages/team/package.json` — peer-dep `@walle-agent/core`; no runtime deps.
- [x] `packages/team/tsconfig.json` — extends base.
- [x] `packages/team/tsup.config.ts` — external `@walle-agent/core`.
- [x] `packages/team/src/team-types.ts` — TeamMember, TeamConfig, TeamRunOptions, Swarm types, Coordinator interface.
- [x] `packages/team/src/blackboard.ts` — Blackboard class + BlackboardEntry type.
- [x] `packages/team/src/sub-agent-tool.ts` — `createSubAgentTool` + `slugifyToolName`.
- [x] `packages/team/src/agent-team.ts` — `AgentTeam` with parallel/pipeline/debate/supervisor.
- [x] `packages/team/src/swarm.ts` — `Swarm` with select-agents early-break safety guard.
- [x] `packages/team/src/create-supervisor.ts` — `createSupervisorTeam` helper.
- [x] `packages/team/src/index.ts` — public exports.
- [x] `packages/team/tests/sub-agent-tool.test.ts` — 9 tests (slugify variants + tool shape + execute).
- [x] `packages/team/tests/blackboard.test.ts` — 4 tests (post/getEntries/renderForAgent/renderFinal).
- [x] `packages/team/tests/agent-team.test.ts` — 12 tests (constructor + 4 strategies + edges).
- [x] `packages/team/tests/swarm.test.ts` — 6 tests (rounds, early-break, synthesize, telemetry).
- [x] `packages/team/tests/create-supervisor.test.ts` — 4 tests (delegate tools, system prompt, overrides, empty members).
- [x] `docs/18-roadmap.md` — Phase 4 acceptance: all 4 boxes ticked.
- [x] `docs/14-team-swarm.md` — 实现备忘 section + drop TeamPlugin block + add createSupervisorTeam helper section + update usage example.
- [x] `plans/mvp-phase4-team/{01-requirements,02-design,03-tasks,04-testing}.md`.

## Out of scope (deferred)

- `TeamPlugin` (empty install). Spec writers acknowledged it's API-driven; skipped.
- `Coordinator.coordinate(...)` consumer — interface only, no built-in implementation. Future Phase-6 self-evolution coordinator may consume it.
- Streaming `AgentTeam.run` (returns `AgentStream` instead of `AgentResult`) — phase 5+ if needed.
- Cross-member memory sharing or shared `sessionId` — deferred.
- Real LLM-backed integration tests — currently the only "real" Agent path is `createSupervisorTeam`'s `Agent.create` with a stub provider. Sufficient for Phase-4 acceptance.
- Auto-injecting team-related tools through a `TeamPlugin` — covered by direct user code.
