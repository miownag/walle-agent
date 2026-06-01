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
| `pnpm basic` / `stream` / `memory` / `evolution` / `mcp` / `rag` / `trace` / `complete` | Run the matching example via `tsx` |

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
