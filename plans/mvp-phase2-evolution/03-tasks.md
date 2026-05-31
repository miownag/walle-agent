# Phase 2 — Evolution Tasks

Ordered checklist. Each item maps to one logical commit.

---

## T1 — Core-runtime additive changes

- [x] `packages/core/src/hooks.ts` — `onRunEnd` payload gains `messages?: ModelMessage[]`.
- [x] `packages/core/src/agent-runtime.ts` — hoist `messages` out of try, pass into `run_end` event + `onRunEnd` hook.
- [x] Existing tests still pass (79/79 in core, 21/21 memory).

## T2 — `@walle-agent/skills` package

- [x] Scaffolding (`package.json`, `tsconfig.json`, `tsup.config.ts`).
- [x] `src/skill-types.ts` — `Skill`, `SkillMetadata`, `SkillTrigger`, `SkillsPluginConfig`.
- [x] `src/skill-file-store.ts` — JSON-file-per-skill.
- [x] `src/skill-registry.ts` — in-memory registry + keyword retrieval + usage metadata updates.
- [x] `src/skills-plugin.ts` — installs `collect_context` listener, attaches `ctx.__skillRegistry`.
- [x] `src/index.ts` — public exports.
- [x] `tests/skill-registry.test.ts` — 5 tests covering load/register/retrieve/remove/usage.
- [x] `tsup build` produces ESM+CJS+DTS.

## T3 — Memory plugin attach point

- [x] `packages/memory/src/memory-plugin.ts` — expose `ctx.__memoryManager = this.manager` so evolution can reach it without importing the memory package types.

## T4 — `@walle-agent/evolution` package

- [x] Scaffolding (`package.json` with peer deps on memory + optional skills, `tsconfig.json`, `tsup.config.ts`).
- [x] `src/evolution-types.ts` — proposal shapes, plugin config, engine deps.
- [x] `src/prompts.ts` — `MEMORY_EXTRACTION_PROMPT`, `SKILL_EXTRACTION_PROMPT`.
- [x] `src/proposal-file-store.ts` — file-per-proposal store with status transitions (pending/approved/rejected/applied).
- [x] `src/evolution-engine.ts`:
  - [x] Three trigger conditions + three extraction paths.
  - [x] `safeJson` tolerant parser.
  - [x] Gates on `minImportance` / `minConfidence`.
  - [x] Three approval paths (auto / sync handler / offline queue).
  - [x] `applyProposal` writing through `MemoryManager.remember` / `SkillRegistry.register`.
  - [x] All triggers wrapped in `safe(...)` to isolate failures.
- [x] `src/evolution-plugin.ts`:
  - [x] Looks up `ctx.__memoryManager` (throws) and `ctx.__skillRegistry` (optional).
  - [x] Registers `onRunEnd` hook with fire-and-forget engine dispatch.
  - [x] Exposes `pending / approveAndApply / reject / runEvolution`.
- [x] `src/index.ts` — public exports.

## T5 — Tests

- [x] `tests/proposal-file-store.test.ts` — enqueue / list / approve / reject / markApplied / delete (4 tests).
- [x] `tests/evolution-engine.test.ts` — triggers + gates + approval paths + JSON fault-tolerance (9 tests).
- [x] `tests/evolution-plugin.integration.test.ts` — end-to-end with Agent + MockProvider that splits traffic between run stream and evolution chat (5 tests).

All 18 new tests pass; `pnpm test` green at 145/145.

## T6 — Example & root wiring

- [x] `examples/evolution.ts` — demonstrates explicit_remember + follow-up + pending skill proposals + `onProposal` observer.
- [x] `examples/package.json` — add `evolution` script + deps on skills/evolution packages.
- [x] Root `package.json` — `pnpm evolution` shortcut.
- [x] `pnpm -r build` green across all packages.

## T7 — Spec update

- [x] `docs/15-self-evolution.md` — reflect real API (status includes `applied`, proposal carries `runId`/`sessionId`/`note`, three approval paths documented).
- [x] `docs/18-roadmap.md` — mark Phase 2 evolution + skills as shipped.
- [x] `plans/mvp-phase2-evolution/**` — this plan (requirements, design, tasks, testing).

---

## Out of scope (later)

- Workflow / Code Skill executors (`SkillExecutor`).
- Embedding-based retrieval behind `SkillStore`.
- Evolution offline loop (trace → eval → PR).
- Memory decay / expiration.
- Skill usage analytics + auto-deprecation.
