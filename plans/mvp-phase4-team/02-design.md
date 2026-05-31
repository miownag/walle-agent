# Phase 4 — Team Design

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│ @walle-agent/team   (top-level orchestrator, NOT a WallePlugin)        │
│                                                                        │
│  AgentTeam(config)                                                     │
│   └─► run(task, { strategy })                                          │
│       ├─ "parallel"   → Promise.all + mergeResults                     │
│       ├─ "pipeline"   → sequential, currentInput threads through       │
│       ├─ "debate"     → N rounds × M members; optional coord summary   │
│       └─ "supervisor" → coordinator.run(task)                          │
│                                                                        │
│  createSupervisorTeam(opts)                                            │
│   ├─► build delegate tools from members                                │
│   ├─► Agent.create({ ..., tools: delegate[] })                         │
│   └─► return new AgentTeam({ members, coordinator })                   │
│                                                                        │
│  Swarm(members, policy, blackboard?)                                   │
│   └─► run(task)                                                        │
│       while policy.shouldContinue(state):                              │
│         selected = policy.selectAgents(...)                            │
│         outputs  = Promise.all(selected.run(blackboard.render))        │
│         blackboard.post(outputs[i])                                    │
│       finalContent = policy.synthesize?(state) ?? blackboard.render()  │
│                                                                        │
│  Blackboard                                                            │
│   ├─ post / getEntries / renderForAgent / renderFinal                  │
│                                                                        │
│  createSubAgentTool(agent, options?)                                   │
│   └─► defineTool({ name: "delegate_<slug>", riskLevel: "low",          │
│                    tags: ["sub-agent"], execute: agent.run })          │
└────────────────────────────────────────────────────────────────────────┘
```

## Module layout

```
packages/team/
├── package.json              peer-dep @walle-agent/core; no runtime deps
├── tsconfig.json             extends ../../tsconfig.base.json
├── tsup.config.ts            external: ["@walle-agent/core"]
├── src/
│   ├── index.ts              public exports
│   ├── team-types.ts         TeamMember, TeamConfig, TeamRunOptions,
│   │                         SwarmPolicy, SwarmState, SwarmRound,
│   │                         Coordinator, CoordinateParams
│   ├── blackboard.ts         Blackboard + BlackboardEntry
│   ├── sub-agent-tool.ts     createSubAgentTool + slugifyToolName
│   ├── agent-team.ts         AgentTeam with 4 strategies
│   ├── swarm.ts              Swarm
│   └── create-supervisor.ts  createSupervisorTeam(opts)
└── tests/                    5 vitest files; stub LLMProvider for create-supervisor
```

Mirrors `packages/sandbox/` (peer-dep + tsup external + no plugin install).

## Key implementation choices

### 1. Tool-name slugification

Spec uses `delegate_${agent.name}` raw. OpenAI/Anthropic both reject names outside
`^[a-zA-Z0-9_-]+$` server-side. We slugify via lowercase + non-alphanumerics→`_` + trim
edge `_` + cap 60 chars + fall back to `"agent"` for empty results. `options.name`
overrides.

### 2. Build-time coordinator construction

Spec's `runSupervisor` reaches into `(coordinator as any).runtime.config.model` to
re-create the coordinator with delegate tools at run time. This breaks the private
boundary on `Agent`/`AgentRuntime`. We replace it with `createSupervisorTeam(opts)`,
which takes `coordinator: { model: LLMProvider, name?, systemPrompt?, plugins? }`,
builds delegate tools from `members`, and calls `Agent.create({ tools: delegate[] })`
once. `AgentTeam.runSupervisor` becomes a one-liner: `coordinator.run(task)`.

`TeamConfig.coordinator: Agent` is still honoured directly — power users who already
have a coordinator wired up can pass it as-is.

### 3. Telemetry aggregation

Spec drops `messages` / `toolCalls` / `events` in two places:

- `runDebate` without coordinator returns empty arrays.
- `Swarm` result's spec literal omits `messages` entirely.

We `flatMap` per-call records into the final `AgentResult` so memory/trace plugins
downstream see the complete picture, matching `runParallel` / `runPipeline`.

### 4. No `TeamPlugin`

Spec `TeamPlugin.install()` is a documented no-op ("Team 功能主要通过 API 调用").
Skipped in this slice. `AgentTeam` / `Swarm` / `Blackboard` are top-level constructors,
not lifecycle-managed by an Agent.

### 5. Swarm safety guards

- `policy.selectAgents(...)` returning `[]` breaks the loop (avoids infinite zero-work
  iteration). Spec was silent on this.
- `policy.shouldContinue` returning false on first call yields a result whose content
  is `""` (or whatever `synthesize` produces). Documented in code comment.

## Public API surface

```ts
export { AgentTeam, Swarm, Blackboard, createSubAgentTool, createSupervisorTeam, slugifyToolName };
export type {
  TeamMember, TeamConfig, TeamRunOptions,
  SwarmPolicy, SwarmState, SwarmRound,
  BlackboardEntry,
  Coordinator, CoordinateParams,
  SubAgentToolInput, SubAgentToolOutput, SubAgentToolOptions,
  SupervisorTeamOptions,
};
```

No re-exports through core. Users import from `@walle-agent/team` directly,
matching every other plugin/orchestrator package.
