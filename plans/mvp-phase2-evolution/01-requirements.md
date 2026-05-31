# Phase 2 — Evolution Requirements

## Goal

Land the **Evolution** and **Skills** slice of Phase 2 on top of the existing Memory
slice, completing the core differentiation of Walle Agent SDK.

- **Skills layer**: extract + store + auto-inject reusable procedures.
- **Evolution layer**: observe agent runs → propose Memory/Skill updates → approve/apply.

Memory layer already shipped — this branch builds on top.

---

## Evolution — Must-Haves

1. **Three triggers**
   - **Explicit remember**: user said "记住 …" / "remember that …" / "from now on …" → LLM extracts durable memories and writes them.
   - **Periodic review**: every N agent runs, distill the recent conversation into structured memories.
   - **Task review**: after a run with ≥ N tool calls, distill the procedure into a reusable Skill proposal.

2. **Human-in-the-loop approval**
   - Each proposal type (`memory` / `skill`) has a `requireApproval` knob.
   - Approval can be sync (`approvalHandler(proposal)` → boolean) or async via the on-disk proposal queue.
   - Queue exposes `pending()` / `approveAndApply(id)` / `reject(id)`.

3. **Never break the parent run**
   - Evolution runs in the background (`fire-and-forget` after `run_end`).
   - Any error inside the engine is logged but swallowed.
   - The agent's user-visible response is **not** delayed by LLM extraction.

4. **Quality gates**
   - `minImportance` / `minConfidence` for memories; `minConfidence` for skills.
   - Memory writes go through `MemoryManager.remember` so dedup still applies.
   - Skills are `type: "prompt"` (workflow / code skills are Phase 3+).

5. **Audit trail**
   - All proposals (even auto-applied) land on disk as `<id>.json`.
   - Status flow: `pending` → (`approved` | `rejected`) → `applied`.
   - Each proposal records `reason`, `runId`, `sessionId`, `createdAt`, `note`.

## Evolution — Acceptance Criteria

- [x] `EvolutionPlugin` throws a clear error if `MemoryPlugin` isn't installed first.
- [x] Fires on `onRunEnd` (not `run_start`) so it sees the final message list.
- [x] Default Chinese + English "remember" regex library triggers `explicit_remember`.
- [x] `periodicReview.everyTurns` counter advances once per `agent.run()` (not per turn).
- [x] `taskReview.minToolCalls` counts tool messages in the final transcript.
- [x] Provider `chat({ responseFormat: "json" })` is used for extraction.
- [x] `safeJson` tolerates markdown-fenced responses and embedded explanations.
- [x] Auto-applied memories end up queryable via `recall` on the next run.
- [x] Queued skills appear in `evolutionPlugin.pending()` and can be approved by id.
- [x] `approveAndApply` transitions the proposal to `applied` and persists the change.

## Skills — Must-Haves

1. **`@walle-agent/skills` package** with `SkillRegistry`, `SkillFileStore`, `SkillsPlugin`.
2. **Full-catalog injection**: every loaded skill's metadata (name + description) is injected into the system prompt on every turn via `collect_context`. No keyword retrieval/ranking — metadata is cheap, retrieval would cost more than it saves.
3. **On-demand body fetch**: a `skill` tool returns the SOP body for a requested skill; `usageCount` + `lastUsedAt` bumped on each successful invocation.
4. **Markdown-file-per-skill** on disk (`<scope>/skills/<slug>/SKILL.md`, YAML
   frontmatter + markdown body) so humans can hand-edit / version-control them.

## Skills — Acceptance Criteria

- [x] Skills loaded at `install` from project + user scope directories.
- [x] `skill` tool registered; returns SOP body by name or slug.
- [x] `collect_context` always injects the full skill catalog (name + description).
- [x] Registry exposes `register/update/remove/list/get/markUsed`.
- [x] `SkillsPlugin` attaches `ctx.__skillRegistry` so EvolutionPlugin can reach it.

---

## Core-runtime changes (additive)

- `onRunEnd` hook now carries the final `messages: ModelMessage[]`.
- `run_end` event on the bus carries the same (previously `[]`).
- No breaking changes — existing hooks that ignored `messages` keep compiling.

---

## Out of Scope (Phase 3+)

- Workflow Skills execution engine (for now `type` is declarative only).
- Code Skills + sandbox execution.
- Embedding-based skill retrieval (keyword only).
- Offline evolution loop (trace analysis, eval dataset generation, PR automation).
- Skill versioning / auto-deprecation.
- Memory expiry / decay.
