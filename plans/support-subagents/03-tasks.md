# Sub-Agents — Tasks

## Status legend
- [ ] todo
- [~] in progress
- [x] done

## Specs

- [ ] `docs/14-team-swarm.md` — append "Dynamic SubAgent (Task tool)" section.
  Differentiate from existing static `createSubAgentTool`.
  Cross-link to `docs/20-builtin-tools.md`.

- [ ] `docs/20-builtin-tools.md` — add `task` row to the tool table; add detailed param/output section after `write_todos`. Note: 默认启用,`riskLevel: low`。

## Core code

- [ ] `packages/core/src/sub-agent-registry.ts` — `SubAgentRegistry` class + `SubAgentDefinition` interface.
- [ ] `packages/core/src/builtin-tools/task-tool.ts` — `createTaskTool({registry, defaultModel?})` factory + `TaskToolInput` / `TaskToolOutput` types.
- [ ] `packages/core/src/builtin-tools/index.ts` — export `createTaskTool`; **不**把 task tool 加入 `BUILTIN_TOOLS` 数组(因为它需要 per-agent 实例化)。
- [ ] `packages/core/src/agent-config.ts` —
  - Add `subAgents?: SubAgentDefinition[]` to `AgentConfig`.
  - Add `subAgents: SubAgentDefinition[]` to `ResolvedAgentConfig`.
  - `resolveConfig` defaults to `[]`.
- [ ] `packages/core/src/agent-runtime.ts` —
  - Field `private subAgentRegistry: SubAgentRegistry`.
  - In ctor: `new SubAgentRegistry()` and pre-populate from `config.subAgents`.
  - In `registerBuiltinTools()`:
    - Honor `useBuiltinTools` include/exclude rules for "task" name.
    - When task is enabled, build `createTaskTool({ registry, defaultModel: config.model })` and `register()` it.
- [ ] `packages/core/src/index.ts` — export `SubAgentRegistry`, `SubAgentDefinition`, `createTaskTool`, `TaskToolInput`, `TaskToolOutput`.

## Team code

- [ ] `packages/team/src/sub-agents-plugin.ts` — `SubAgentsPlugin` (uses core registry + factory).
- [ ] `packages/team/src/index.ts` — export `SubAgentsPlugin` + types.

## Tests (vitest, mock LLM only)

- [ ] `packages/core/tests/sub-agent-registry.test.ts` — register/get/has/list/types/duplicate-throw.
- [ ] `packages/core/tests/task-tool.test.ts` —
  - happy path:已注册 type → child run → returns `{result}`.
  - unknown type → returns `{error, available}` 不抛。
  - verbose: true → returns `{result, messages, toolCalls}`.
  - model 继承(未指定 def.model 时用 defaultModel)。
  - signal propagation(parent abort → child run sees aborted signal)。
  - dispose 一定被调(用 spy)。
  - inheritSession: true → child sessionId === parent。
  - tool registered as built-in:测试默认开,`useBuiltinTools: { excludeTools: ["task"] }` 关闭。
- [ ] `packages/team/tests/sub-agents-plugin.test.ts` — install 后 task 工具可在 toolRegistry.list() 找到;types 列表正确。

## Examples & verification

- [ ] `examples/sub-agents.ts` — 演示 `AgentConfig.subAgents` 糖语法 + plugin 形态。
- [ ] `pnpm build` 全包构建通过。
- [ ] `pnpm test` 全测试通过。
- [ ] `pnpm lint` 通过(若启用)。

## Out of scope (deferred)

- Streaming sub-agent 输出回主 Agent。
- Sub-agent 实例池/复用。
- 自动从 skills 仓库发现 SubAgentDefinition(可走 SkillsPlugin 后续扩展)。
