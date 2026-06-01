# Walle Agent SDK

Walle is a TypeScript Agent SDK that lets you build your own agents. It is designed as a **micro-core + plugin** architecture: a tiny zero-dependency core (`@walle-agent/core`) plus opt-in plugin packages (memory, skills, evolution, MCP, RAG, sandbox, team, trace) that compose on top of it.

> Tagline: 微核心 + 插件体系 + 自进化闭环

---

## Repo Layout

This is a **pnpm monorepo** (`pnpm-workspace.yaml` covers `packages/*` and `examples`).

```
walle-agent/
├── CLAUDE.md                # ← this file (also linked as AGENTS.md)
├── AGENTS.md                # symlink → CLAUDE.md
├── README.md / README.zh.md # bilingual top-level intro
├── docs/                    # Specs (Spec-Driven Development)
│   └── INDEX.md             # Spec index — READ THIS FIRST
├── plans/                   # Long-term development plans (one folder per task)
│   └── README.md            # Explains plan folder structure
├── packages/                # Each is an independently published npm package
│   ├── core/                # @walle-agent/core — Agent, Runtime, Tool, Hooks, EventBus, TokenBudget
│   ├── openai/              # @walle-agent/openai — OpenAI LLM Provider
│   ├── anthropic/           # @walle-agent/anthropic — Anthropic LLM Provider
│   ├── memory/              # @walle-agent/memory — layered memory + file store
│   ├── skills/              # @walle-agent/skills — skill system + retrieval
│   ├── mcp/                 # @walle-agent/mcp — MCP protocol integration
│   ├── evolution/           # @walle-agent/evolution — self-evolution engine
│   ├── rag/                 # @walle-agent/rag — RAG plugin
│   ├── sandbox/             # @walle-agent/sandbox — Local/Docker sandbox
│   ├── team/                # @walle-agent/team — Team / Swarm / Coordinator
│   └── trace/               # @walle-agent/trace — observability (JSONL/OTEL)
└── examples/                # Runnable demos (basic, streaming, memory, evolution, mcp, rag, trace, complete)
```

### Package dependency rule
`core` has **zero external runtime deps**. All other packages depend on `core`. `evolution` peer-depends on `memory` + `skills`. Do not introduce a runtime dep into `core` without strong justification.

---

## Spec-Driven Development (SDD)

This repo is built spec-first.

1. **Before coding**, read [`docs/INDEX.md`](./docs/INDEX.md) and the relevant numbered spec (`01-architecture.md` … `20-builtin-tools.md`).
2. **After coding**, if behavior diverges from the spec, **update the spec in the same change**. Specs are the source of truth — stale specs are bugs.

---

## Plans (long-term task records)

Every complex / multi-session task lives under [`plans/<task-name>/`](./plans/) with the canonical 4-file layout:

```
plans/<task-name>/
├── 01-requirements.md
├── 02-design.md
├── 03-tasks.md
└── 04-testing.md
```

Treat `plans/` as **long-term evidence of the development process** — it is as important as `docs/`. Read [`plans/README.md`](./plans/README.md) before adding a new plan folder.

---

## Development Commands

Run from the repo root unless noted.

| Command | What it does |
|---|---|
| `pnpm install` | Install workspace deps |
| `pnpm build` | Build all packages (`pnpm -r build` → `tsup`) |
| `pnpm test` | Run vitest across all packages (`packages/*/tests/**/*.test.ts`) |
| `pnpm test:watch` | Watch-mode tests |
| `pnpm lint` | ESLint over `packages/*/src/**/*.ts` |
| `pnpm clean` | Remove all `dist/` outputs |
| `pnpm basic` / `stream` / `memory` / `evolution` / `mcp` / `rag` / `trace` / `sub-agents` / `compaction` / `tool-search` / `complete` | Run the matching example via `tsx` |

Node `>= 20`, pnpm `10.29.x` (see `packageManager`).

---

## Conventions

- **File / folder names: kebab-case.** No exceptions.
- **TypeScript:** `strict: true`, ESM (`"type": "module"`), `verbatimModuleSyntax`. Use `import type { ... }` for types.
- **Public API:** every package re-exports its public surface from `src/index.ts`. Don't import from a package's internal paths.
- **Tests:** colocate per package under `packages/<pkg>/tests/`, named `*.test.ts`.
- **Build tool:** `tsup` per package; output to `dist/` (CJS + ESM + `.d.ts`).
- **Workspace deps:** use `workspace:*` (see `examples/package.json`).
- **Ask first** when a spec or requirement is unclear — don't silently invent behavior. SDD relies on this.

---

## When You Touch Code, Also…

- ✅ Update the matching `docs/NN-*.md` if behavior changed
- ✅ Update / create a `plans/<task>/` folder for non-trivial work
- ✅ Add or update tests under `packages/<pkg>/tests/`
- ✅ Keep `core` dependency-free
- ✅ Run `pnpm build && pnpm test` before declaring done

---

## Quick Start (Target API)

```ts
import { Agent } from "@walle-agent/core";
import { OpenAIProvider } from "@walle-agent/openai";
import { MemoryPlugin } from "@walle-agent/memory";
import { SkillsPlugin } from "@walle-agent/skills";
import { EvolutionPlugin } from "@walle-agent/evolution";

const agent = await Agent.create({
  name: "Walle",
  model: new OpenAIProvider({ model: "gpt-4" }),
  plugins: [
    new MemoryPlugin({ rootDir: "./.walle" }),
    new SkillsPlugin({ project: "./.agents", user: "~/.agents" }),
    new EvolutionPlugin({
      explicitRemember: { enabled: true },
      periodicReview: { enabled: true, everyTurns: 10 },
      taskReview: { enabled: true, minToolCalls: 5 },
    }),
  ],
});

// Non-streaming; passing sessionId persists messages and replays across runs
const result = await agent.run("帮我总结这个文件", { sessionId: "user-42" });

// Streaming
for await (const event of agent.run("帮我总结这个文件", { stream: true, sessionId: "user-42" })) {
  if (event.type === "text_delta") process.stdout.write(event.content);
}
```

See [`examples/`](./examples/) for runnable end-to-end variants.

---

## Sub-Agents (dynamic dispatch via the built-in `task` tool)

Aligned with Claude Code: register sub-agent **types** up front, then let
the parent LLM dispatch dynamically through one built-in `task` tool. Each
call instantiates a fresh sub-agent, runs the prompt, and disposes it.

Three equivalent entry points:

```ts
// 1) Sugar — AgentConfig.subAgents (recommended default)
const agent = await Agent.create({
  name: "Walle",
  model,
  subAgents: [
    { type: "researcher", systemPrompt: "...", tools: [webSearchTool] },
    { type: "code-reviewer", systemPrompt: "..." },
  ],
});

// 2) Plugin — SubAgentsPlugin from @walle-agent/team
import { SubAgentsPlugin } from "@walle-agent/team";
const agent = await Agent.create({
  model,
  plugins: [new SubAgentsPlugin({ types: [/* SubAgentDefinition[] */] })],
});

// 3) Low-level — createTaskTool factory
import { SubAgentRegistry, createTaskTool } from "@walle-agent/core";
const registry = new SubAgentRegistry();
registry.register({ type: "researcher", systemPrompt: "..." });
const agent = await Agent.create({
  model,
  tools: [createTaskTool({ registry, defaultModel: model })],
  useBuiltinTools: { excludeTools: ["task"] }, // disable the built-in
});
```

Defaults that align with Claude Code:

- The parent LLM sees **one** `task` tool with `{ subagent_type, description, prompt }`.
- Sub-agent runs to completion in isolation; only its final content is returned (`{ result }`). Set `verbose: true` on the definition to also surface `messages` + `toolCalls`.
- Sub-agent's `model` defaults to the parent's model; override per-type with `def.model`.
- Sub-agent's `useBuiltinTools` defaults to `false` (prevents accidental `task` recursion).
- `inheritSession: false` by default — sub-agent gets its own `sessionId` so memory plugins don't cross-contaminate.
- Parent abort / signal propagates into the child run.
- `config.subAgents` and `SubAgentsPlugin` are **mutually exclusive** — the plugin throws on install if both are used.

Spec: [`docs/14-team-swarm.md`](./docs/14-team-swarm.md#dynamic-subagenttask-工具).
Plan: [`plans/support-subagents/`](./plans/support-subagents/).

The pre-existing `createSubAgentTool` (static wrapper, one `delegate_<slug>`
tool per Agent instance) stays as the long-lived "specialists already
instantiated" pattern; the new `task` tool is the dynamic-dispatch
counterpart. Both can be combined on the same parent Agent.

---

## Context Compression (micro + macro)

Walle keeps long-running conversations under control with two layers:

```ts
const agent = await Agent.create({
  name: "Walle",
  model,
  plugins: [
    new MemoryPlugin({
      rootDir: "./.walle",
      toolResults: {
        // Most recent N assistant turns stay verbatim in the live messages
        // array; older tool results become placeholders pointing at on-disk
        // copies, reachable via `read_tool_result`.
        keepRecentTurns: 3,
        thresholdChars: 0,        // 0 = always evict to disk
        previewHeadLines: 10,
        previewTailLines: 10,
      },
    }),
  ],
  // Macro is opt-in (an extra LLM call summarises the head region).
  macroCompression: {
    enabled: true,
    threshold: 0.8,               // est tokens > 80% maxContextTokens
    keepRecentTurns: 3,
  },
});

// Manual trigger
await agent.compact();
```

- **Micro**: per-turn rewrite of older `role: "tool"` messages into placeholder
  text (`[ToolResult #N evicted | toolCallId=… | …]`). Backed by the existing
  `ToolResultVault` on disk.
- **Macro**: between-turn (or manual) summary of the head region into a single
  `[Summary of N earlier messages]` user message; preserves system messages
  and the most recent N assistant turns.
- **read_tool_result**: built-in tool — line-paginated read of any evicted
  tool result by its `toolCallId`. Requires `@walle-agent/memory`.

Spec: [`docs/21-context-compression.md`](./docs/21-context-compression.md).
Plan: [`plans/context-compression/`](./plans/context-compression/).

---

## Tool Search (shadow registry + dynamic discovery)

When the registered tool count is large (typical with multiple MCP servers),
Walle hides MCP-tagged tools behind two helpers so each LLM turn doesn't
have to ship 50+ JSON schemas.

```ts
const agent = await Agent.create({
  name: "Walle",
  model,
  plugins: [/* MCPPlugin etc. */],
  toolSearch: {
    enabled: true,                   // default: true
    mode: "auto",                    // "auto" | "force" | "off"
    threshold: 30,                   // auto: shadow only when total > N
    alwaysShadowTags: ["mcp"],       // default
    alwaysActiveTags: ["builtin"],   // default
  },
});

// Inspect:
agent.listVisibleTools();            // includes tool_search + defer_execute_tool
agent.listHiddenTools();             // shadowed MCP tools
```

- `tool_search({ keywords, servers?, tags?, limit? })` — keyword + regex
  search across all registered tools (active + shadowed). Returns ranked
  matches with their full schemas.
- `defer_execute_tool({ qualifiedName, arguments })` — invoke a hidden tool
  by qualifiedName. Goes through the standard permission policy.

Spec: [`docs/22-tool-search.md`](./docs/22-tool-search.md).
Plan: [`plans/tool-search/`](./plans/tool-search/).
