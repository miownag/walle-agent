# Phase 2 — Memory + Evolution Requirements

## Goal

Implement self-evolution capabilities that differentiate Walle Agent SDK:

- **Memory Layer (THIS ITERATION)**: Persistent, file-backed short-term (session) + long-term (knowledge) memory, plus automatic offloading of oversized tool results.
- **Skills Layer (follow-up)**: Extract, store, and apply reusable skills from interactions.
- **Evolution Layer (follow-up)**: Automatic memory/skill proposals based on agent performance.

Scope for this branch is **Memory only**. Skills + Evolution are tracked here for context but will ship in subsequent branches.

---

## Memory — Must-Haves (this branch)

These three requirements drive the design:

1. **Append-on-write JSONL session log.**
   New messages (user / assistant / tool) are appended to a JSONL file in the session directory immediately — *not* batched at end of run. Survives crashes; trivially tailable.

2. **Oversized tool-result eviction into the filesystem, with next-turn summarization.**
   When a tool result exceeds a configurable size:
   - The *current* turn still sees the full content (the agent needs it to reason).
   - The JSONL log stores a stub `{ _largeRef: <id>, preview, path }` and the full content is written to `./.walle/memory/large-tool-results/<id>.txt`.
   - On the **next turn**, when history is reloaded, the oversized tool result is rendered as a short summary:
     > `Tool result too long. You can read ./.walle/memory/large-tool-results/<id>.txt if needed.`
     followed by a head+tail preview of the content.
   - **Definition of "next turn"**: a new `agent.run()` invocation whose prior run ended in a status other than `user-cancelled`. If the previous run was cancelled by the user (e.g. abort via `AbortSignal`) and the user continues, the resumed run re-hydrates the full tool content (it is treated as the same thought, not a new turn).

3. **Layered short-term + long-term memory.**
   - **Short-term memory (STM)** — the session message log on disk (JSONL). Loaded back into the prompt on resume. One directory per session.
   - **Long-term memory (LTM)** — structured `MemoryItem` records persisted in `./.walle/memory/memories.jsonl`. Injected into the system prompt via `collect_context` using keyword retrieval. Written through a `remember` tool and/or programmatic API. Dedup + forget supported.
   - Design follows patterns from `langchain-ai/deepagents` (filesystem-backed memory + tool-result eviction), Hermes-style scratchpad, OpenClaw's role distribution, and LangChain's `BaseStore` checkpoint.

## Memory — Acceptance Criteria

### Session Log / Short-Term Memory
- [ ] `messages.jsonl` under `./.walle/sessions/<sessionId>/` is append-only. Each message is written as soon as it is produced (user on run start, assistant on model-call end, tool on tool-call end).
- [ ] `runs.jsonl` in the same directory records each run's `{ runId, startAt, endAt, status }`. Status is one of `completed | user-cancelled | error`.
- [ ] On a subsequent `agent.run({ sessionId })`, the prior session messages are replayed into the LLM request as `conversationHistory` before the new user input.
- [ ] No server / external store needed — pure Node `fs`.
- [ ] Session id is stable across runs (user supplies, or derived from agent id if absent).

### Tool-Result Eviction
- [ ] Configurable threshold (default: 20000 chars, matching deepagents' ~20k tokens).
- [ ] Oversized tool outputs are written to `./.walle/memory/large-tool-results/<toolCallId>.txt`.
- [ ] The JSONL entry for the tool message stores the stub (preview + ref), **not** the full payload.
- [ ] In the *current* run's in-memory state, the tool result remains **full** so the agent can reason over it.
- [ ] On loading past messages for a **new non-cancelled turn**, the stub is rendered as the summary string (`Result is too long. You can read ./.walle/memory/large-tool-results/<id>.txt if needed.` + head/tail preview).
- [ ] On loading past messages when the previous run was `user-cancelled`, the stub is rehydrated from the filesystem back to full content.
- [ ] The `read_file` built-in can be used by the agent to pull specific slices of the evicted file.

### Long-Term Memory
- [ ] `MemoryItem` JSONL store at `./.walle/memory/memories.jsonl`.
- [ ] `remember` tool: agent can write facts/preferences into LTM (triggered either by user "记住 X" phrasing or agent judgement).
- [ ] `recall` tool: agent can query LTM keyword/tags.
- [ ] `forget` tool: delete by id.
- [ ] LTM is auto-injected into system prompt each run via `collect_context` (top-K matches on the input query).
- [ ] Jaccard-similarity-based dedup on write.
- [ ] No external vector DB (keyword retrieval only for MVP).

### Plugin / API surface
- [ ] `MemoryPlugin` is a `WallePlugin` — registers tools, hooks, and a `collect_context` listener.
- [ ] Configurable paths (`storePath`, `sessionsPath`, `largeResultsPath`).
- [ ] Disposable (flushes pending writes on `dispose()`).
- [ ] Exposed programmatic API: `memoryPlugin.manager.remember(...)`, `.forget(...)`, `.list(...)`, `.retrieve(...)`.

### Cross-cutting runtime changes
- [ ] `AgentRuntime` gains a `collect_messages` event (plugins push prior `ModelMessage[]` into the turn).
- [ ] `PromptBuilder.build` accepts `conversationHistory` and emits them between system and current user message.
- [ ] `run_start` / `run_end` events carry `runId`, `sessionId`, and (for end) a `status`.
- [ ] `AbortSignal.aborted` at run-end maps to `user-cancelled`.

---

## Skills System (follow-up branch)
- [ ] Skill interface: name, description, parameters, execution context
- [ ] SkillRegistry for registration and dynamic lookup
- [ ] Skills injected into prompt as tools alongside native tools
- [ ] Skills can wrap complex logic (multiple steps, conditions)
- [ ] SkillFileStore persists to JSON with version tracking
- [ ] Skills tagged (domain, complexity, success_rate) for filtering
- [ ] Skill retrieval injects top-K relevant skills via `collect_context`

## Evolution System (follow-up branch)
- [ ] Agent detects explicit "Remember" → auto-write to memory
- [ ] Agent detects skill-like patterns → generate MemoryProposal/SkillProposal
- [ ] Periodic review triggered every N turns (configurable)
- [ ] Review analyzes recent tool calls and results
- [ ] Proposals persisted to ProposalFileStore for human approval
- [ ] Approved proposals auto-convert to Memory/Skill entries
- [ ] TokenBudget correctly trims overflow when memory/skills injected
- [ ] Evolution state tracked (last_review_turn, pending_proposals)

---

## Out of Scope (Phase 3+)

- Embedding-based retrieval (needs vector DB)
- Cross-session memory sharing between users
- Memory conflict resolution strategies
- Workflow Skills with conditional execution
- Skill auto-optimization via offline trace analysis
- Distributed session log (network / remote fs)
