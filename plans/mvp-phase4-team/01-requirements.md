# Phase 4 — Team Requirements

## Why this slice

Roadmap Phase-4 acceptance (`docs/18-roadmap.md`):

- Pipeline 模式：Research → Code → Review 流水线执行
- Parallel 模式：多 Agent 并行执行并汇总
- Supervisor 模式：Coordinator 动态分配子任务
- SubAgent 封装为 Tool 可被调用

Spec source: `docs/14-team-swarm.md`.

## Functional requirements

- New package `@walle-agent/team` (peer-dep `@walle-agent/core`).
- `createSubAgentTool(agent, options?)` — wrap an Agent as a `Tool<{ task }, { result }>`.
  - Auto-slugify `agent.name` so the result fits `^[a-zA-Z0-9_-]+$` (OpenAI/Anthropic constraint).
  - Allow `options.name` and `options.description` overrides.
  - `riskLevel: "low"`, `tags: ["sub-agent"]`.
- `AgentTeam` with `run(task, { strategy })` and four strategies:
  - **parallel**: `Promise.all(members.run(task))`; concatenate outputs with section headers.
  - **pipeline**: sequential; each member's prompt includes the prior content; supports `pipelineOrder`.
  - **debate**: N rounds × M members in lockstep; optional `coordinator` summarises.
  - **supervisor**: defers to `coordinator.run(task)`; coordinator must already carry delegate tools.
- `createSupervisorTeam(options)` helper that builds the coordinator with delegate tools at construction time. Cleaner than the spec's `(coordinator as any).runtime.config.model` reach-through.
- `Swarm` + `SwarmPolicy` + `Blackboard`: dynamic round-robin orchestrator gated by policy.

## Non-functional requirements

- No core changes — Phase 4 is purely additive.
- Match the package conventions of `@walle-agent/sandbox` (peer-dep, tsup external, vitest unit tests, no real LLM calls).
- Aggregate `messages` / `toolCalls` / `events` across sub-runs into the returned `AgentResult` so memory + trace plugins downstream see the full picture.

## Out of scope (deferred)

- `TeamPlugin` (`WallePlugin` shell that registers nothing) — deferred. Spec class is empty.
- `Coordinator.coordinate(...)` consumer logic — interface ships, no built-in coordinator implementation yet.
- Streaming variants of `AgentTeam.run` — Phase 5+ if needed.
- Cross-member memory sharing / shared sessionId — deferred.
- Real multi-Agent integration tests against an LLM — relies on stub provider for now.
