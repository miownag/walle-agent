# Phase 2 — Evolution Design

This document covers the **Skills** and **Evolution** slice of Phase 2. Memory
already shipped; it's a hard prerequisite.

Spec references:
- `docs/15-self-evolution.md` — Evolution plugin contract + proposal types.
- `docs/08-skills.md` — Skills plugin contract.
- `docs/03-core-runtime.md` — execution loop + EventBus + Hooks.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│ @walle-agent/skills                                                    │
│                                                                        │
│  SkillsPlugin                                                          │
│   ├─► SkillRegistry          (in-memory Map<slug, Skill>, 2 scopes)    │
│   │    └─ register / update / remove / list / markUsed                 │
│   ├─► SkillFileStore x 2     (project=./.agents, user=~/.agents;       │
│   │                           <root>/skills/<slug>/SKILL.md)           │
│   ├─► `skill` tool           (LLM-facing: returns SOP body on demand)  │
│   └─► collect_context        (always injects full catalog: name + desc)│
│                                                                        │
│  Attachment point: ctx.__skillRegistry = registry                      │
└────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────┐
│ @walle-agent/evolution                                                 │
│                                                                        │
│  EvolutionPlugin                                                       │
│   ├─► Looks up ctx.__memoryManager  (required)                         │
│   ├─► Looks up ctx.__skillRegistry  (optional; gates taskReview)       │
│   ├─► EvolutionEngine                                                  │
│   │    ├─ shouldExplicitRemember(ctx)                                  │
│   │    ├─ shouldPeriodicReview(ctx)                                    │
│   │    ├─ shouldTaskReview(ctx)                                        │
│   │    ├─ extractMemoryProposals (LLM + MEMORY_EXTRACTION_PROMPT)      │
│   │    ├─ extractSkillProposal   (LLM + SKILL_EXTRACTION_PROMPT)       │
│   │    ├─ commitProposal         (gates + approval routing)            │
│   │    └─ applyProposal          (memory.remember / skills.register)   │
│   └─► ProposalFileStore          (<id>.json with status transitions)   │
│                                                                        │
│  Hook: onRunEnd → (fire-and-forget) engine.afterRun({ messages })      │
└────────────────────────────────────────────────────────────────────────┘
```

### Plugin ordering

```
MemoryPlugin → SkillsPlugin → EvolutionPlugin
```

Enforced by install-time reads of `ctx.__memoryManager` (throws if missing) and
`ctx.__skillRegistry` (optional).

---

## Directory layout

```
./.walle/
  memory/
    memories.jsonl                  # from MemoryPlugin
    large-tool-results/             # from MemoryPlugin
  sessions/                         # from MemoryPlugin
  evolution/
    proposals/
      <proposalId>.json             # one file per proposal (all statuses)

./.agents/                          # Skills — project scope (configurable)
  skills/
    <slug>/
      SKILL.md                      # YAML frontmatter + markdown body

~/.agents/                          # Skills — user scope (configurable, read-only from registry)
  skills/
    <slug>/
      SKILL.md
```

All roots are configurable on the respective plugin configs. Project-scope skills override user-scope skills on slug collision; `register()` always writes to project scope.

---

## Data shapes

```ts
// Skills
interface Skill {
  id: string;
  name: string;
  description: string;
  type: "prompt" | "workflow" | "code";   // only "prompt" implemented
  content: string;
  tags?: string[];
  version?: string;
  trigger?: { keywords?: string[]; examples?: string[]; embedding?: number[] };
  metadata: {
    createdBy: "human" | "agent";
    createdAt: string;
    updatedAt?: string;
    usageCount: number;
    successCount: number;
    confidence: number;
    lastUsedAt?: string;
  };
}

// Proposals
interface EvolutionProposal {
  id?: string;
  type: "memory" | "skill";
  payload: MemoryProposal | SkillProposal;
  reason: "explicit_remember" | "periodic_review" | "task_review";
  runId?: string;
  sessionId?: string;
  createdAt?: string;
  status?: "pending" | "approved" | "rejected" | "applied";
  note?: string;
}
```

---

## Triggers

| Trigger | Condition | Extraction input | Output |
|---------|-----------|------------------|--------|
| `explicit_remember` | last user msg matches a regex in the pattern library | `{user, assistant}` last exchange | 0..N `MemoryProposal` |
| `periodic_review` | `turnCounter > 0 && turnCounter % everyTurns === 0` | last `maxMessagesInReview` flattened messages | 0..N `MemoryProposal` |
| `task_review` | `messages.filter(role==="tool").length >= minToolCalls` and `skills` registry is present | last `maxMessagesInReview` flattened messages | 0..1 `SkillProposal` |

`turnCounter` increments once per `onRunEnd`, not per turn inside the run. This
matches the semantics users expect from "every 10 conversations" more than
"every 10 LLM calls".

---

## Control flow

```
agent.run(...)
    │
    ▼
 (run loop) → produces `messages: ModelMessage[]`
    │
    ▼
 hook: onRunEnd({ runId, sessionId, status, messages })
    │
    ├─► SessionLog.appendRunEnd        (MemoryPlugin)
    │
    └─► turnCounter++                  (EvolutionPlugin)
        void engine.afterRun({turn, runId, sessionId, messages})
             │
             ├─ explicit_remember? → chat(memory prompt) → proposals
             ├─ periodic_review?   → chat(memory prompt) → proposals
             └─ task_review?       → chat(skill prompt)  → proposal?
                   │
                   ▼
             commitProposal
                 │
                 ├─ gates (minImportance / minConfidence) fail → drop
                 ├─ requireApproval=false
                 │    → enqueue(pending) → applyProposal → markApplied
                 ├─ requireApproval=true + approvalHandler
                 │    → handler returns true  → applyProposal (no queue)
                 │    → handler returns false → drop
                 └─ requireApproval=true + no handler
                      → enqueue(pending); wait for external approveAndApply
```

**Errors** inside the engine are swallowed with `console.error`. Evolution
**never** throws into the run loop.

**Back-pressure**: Evolution doesn't block `run()` — the hook invokes the
engine with `void ...` and returns immediately. This matters for user-facing
latency but creates one caveat: the user can't rely on a synchronous "memory
is stored" signal for the run that triggered the write. Tests handle this with
`waitForCondition`.

---

## LLM extraction

Both prompts require strict JSON. `safeJson` handles three real-world cases:

1. Raw JSON response — direct `JSON.parse`.
2. `\`\`\`json ... \`\`\``-fenced — strip fences, then parse.
3. Prose + embedded JSON — regex-extract first `{...}` and parse.

On any parse failure, extraction returns `[]` / `null` (no proposal) without
surfacing an error.

`chat({ responseFormat: "json" })` is used; providers that honour it (OpenAI,
Anthropic JSON mode, compatible vendors) tighten the output automatically.

---

## Approval UX

Three approval paths are supported so that the same package serves multiple
deployment models:

1. **Fully autonomous** (`requireApproval=false`) — for personal agents. Auto
   apply, keep an audit trail.
2. **Sync approval callback** — for CLIs that prompt the operator inline.
   Returning `true` applies without ever writing to disk; returning `false`
   drops silently.
3. **Offline queue** (`requireApproval=true`, no handler) — for multi-agent
   teams. The proposal lives as `<id>.json` until someone calls
   `evolutionPlugin.approveAndApply(id)` (from a CLI, a Slack bot, a Web UI…).

The `status` lifecycle (`pending` → `approved` → `applied`) is visible from all
three paths so users always have a consistent record.

---

## Public API (evolution)

```ts
class EvolutionPlugin {
  readonly proposalStore: ProposalStore;
  engine?: EvolutionEngine;

  pending(): Promise<EvolutionProposal[]>;
  approveAndApply(id: string, note?: string): Promise<EvolutionProposal | undefined>;
  reject(id: string, note?: string): Promise<EvolutionProposal | undefined>;
  runEvolution(runId, sessionId?, messages): Promise<void>;  // testing hook
}
```

---

## File inventory (this branch)

**New packages**

- `packages/skills/**` — full plugin.
- `packages/evolution/**` — full plugin.

**Modified (core)**

- `packages/core/src/hooks.ts` — `onRunEnd` payload gains `messages?: ModelMessage[]`.
- `packages/core/src/agent-runtime.ts` — hoist `messages` out of the try block,
  forward it to the `run_end` event and the `onRunEnd` hook.

**Modified (memory)**

- `packages/memory/src/memory-plugin.ts` — attach `ctx.__memoryManager = manager`
  so evolution can find the long-term store without depending on the memory
  package's types at runtime.

**Modified (examples + root)**

- `examples/evolution.ts` + `examples/package.json` (+ root `package.json`): add
  `pnpm evolution` script.
- `docs/15-self-evolution.md`, `docs/18-roadmap.md` — update spec to match.
- `plans/mvp-phase2-evolution/**` — this plan.

---

## Key design decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Where to trigger | `onRunEnd` hook | Needs final messages + final run status; run-end is the right boundary. |
| Fire-and-forget evolution | Yes | User-visible latency matters; evolution is a side-channel. |
| Prompt vs chat for extraction | Non-streaming `chat(responseFormat=json)` | Easier to parse and cheap for this usage; review is async so latency doesn't matter. |
| Proposal storage | File-per-proposal JSON | Human-readable, version-controllable, no DB dep. |
| Approval paths | Three (auto / sync / offline) | One plugin covers personal, CLI, and team use cases. |
| `turnCounter` unit | Runs, not turns | Users think in conversations. |
| Trigger failure isolation | `Promise<void>` safe wrappers | One flaky trigger must not break the others. |
| LLM JSON tolerance | `safeJson` with fences + regex fallback | Real-world LLMs regularly wrap JSON in prose. |
| Skills `type` surface | All three typed, only `prompt` applied | Keeps types stable so Phase 3 can add executors without breaking changes. |

---

## Follow-ups (out of scope)

- Workflow / Code Skill executors.
- Embedding-based Skill retrieval.
- Offline Evolution loop (trace → eval → PR).
- `FINAL_MESSAGE_TOKENS` budget for review prompts (currently slice-based).
- Cross-session memory sharing.
- Skill usage-success analytics for auto-deprecation.
