# Walle Agent SDK

> **English** · [中文](./README.zh.md)

A TypeScript Agent SDK with a **micro-core + plugin architecture** and a built-in
**self-evolution** loop. Build agents that remember, evolve their skills, run
sandboxed shell commands, retrieve from a knowledge base, orchestrate teams, and
keep an audit trail — all from one composable runtime.

```ts
import { Agent } from "@walle-agent/core";
import { OpenAIProvider } from "@walle-agent/openai";
import { MemoryPlugin } from "@walle-agent/memory";
import { SkillsPlugin } from "@walle-agent/skills";
import { EvolutionPlugin } from "@walle-agent/evolution";

const agent = await Agent.create({
  name: "Walle",
  model: new OpenAIProvider({ model: "gpt-4o-mini" }),
  plugins: [
    new MemoryPlugin({ rootDir: "./.walle" }),
    new SkillsPlugin({ project: "./.agents" }),
    new EvolutionPlugin({ explicitRemember: { enabled: true } }),
  ],
});

const result = await agent.run("Summarise the deploy runbook for me.", {
  sessionId: "user-42",
});
```

---

## Why Walle

| Pillar | What it gets you |
|---|---|
| **Micro-core** | The runtime is just `Agent` + `EventBus` + `ToolRegistry` + plugin hooks. Everything else (memory, skills, sandbox, RAG, trace, team) ships as opt-in packages. |
| **Self-evolution** | Built-in: explicit `remember` tool, periodic review, post-task skill extraction → file-backed proposal queue with approval callback. |
| **Streaming-first** | Same `agent.run(...)` returns either a `Promise<AgentResult>` or an async-iterable `AgentStream` based on `{ stream: true }`. |
| **Interrupt + resume** | `agent.interrupt()` is honoured cooperatively; cancelled tool outputs rehydrate on `Agent.resume(sessionId, ...)`. |
| **Permissions** | First-class policy: `mode`, `allowTools`, `denyTools`, `requireApprovalFor: { riskLevel, fileWrite, network, shell }`, async `approvalHandler`. |
| **Sandbox** | `LocalSandbox` (execa) and `DockerSandbox` registered behind a `shell` tool with the same risk gating. |
| **Multi-agent** | `AgentTeam` (parallel / pipeline / debate / supervisor), `Swarm` + `SwarmPolicy`, `Blackboard`, `createSubAgentTool`. |
| **Audit trail** | `TracePlugin` records every event to JSONL or in-memory; OTEL-friendly via `customStore` injection. |
| **Spec-driven** | Every package's design is captured in [`docs/`](./docs/INDEX.md) and the per-slice deltas live in [`plans/`](./plans/). |

---

## Install

```bash
pnpm add @walle-agent/core @walle-agent/openai
# add only the plugins you actually use:
pnpm add @walle-agent/memory @walle-agent/skills @walle-agent/evolution
pnpm add @walle-agent/sandbox @walle-agent/permissions
pnpm add @walle-agent/mcp @walle-agent/rag @walle-agent/trace @walle-agent/team
```

Requires **Node.js ≥ 20** and ESM. The SDK is published as ESM-first with CJS
fallbacks.

---

## Packages

| Package | What it does | Spec |
|---|---|---|
| [`@walle-agent/core`](./packages/core) | Agent, runtime, event bus, tool registry, hooks, middleware, permissions, built-in tools | [03](./docs/03-core-runtime.md) · [12](./docs/12-hooks-middleware.md) · [13](./docs/13-permissions.md) · [20](./docs/20-builtin-tools.md) |
| [`@walle-agent/openai`](./packages/openai) | OpenAI / OpenAI-compatible provider with streaming + tool-calls | [05](./docs/05-llm-provider.md) |
| [`@walle-agent/anthropic`](./packages/anthropic) | Anthropic provider with streaming + extended thinking | [05](./docs/05-llm-provider.md) |
| [`@walle-agent/memory`](./packages/memory) | Session log (JSONL), long-term memory, ToolResultVault, `remember` / `recall` / `forget` tools | [09](./docs/09-memory.md) |
| [`@walle-agent/skills`](./packages/skills) | `.claude/skills`-style SOP catalog, project + user scopes, system-prompt injection | [08](./docs/08-skills.md) |
| [`@walle-agent/evolution`](./packages/evolution) | Memory + skill extraction engine, file-backed proposal queue, approval callback | [15](./docs/15-self-evolution.md) |
| [`@walle-agent/mcp`](./packages/mcp) | MCP client manager, stdio + Streamable-HTTP transports, tool whitelist/blacklist | [07](./docs/07-mcp.md) |
| [`@walle-agent/sandbox`](./packages/sandbox) | `Sandbox` interface, `LocalSandbox` (execa), `DockerSandbox`, `shell` tool registration | [11](./docs/11-sandbox.md) |
| [`@walle-agent/team`](./packages/team) | `AgentTeam` (parallel / pipeline / debate / supervisor), `Swarm`, `Blackboard`, `createSubAgentTool`, `createSupervisorTeam` | [14](./docs/14-team-swarm.md) |
| [`@walle-agent/rag`](./packages/rag) | `RAGPlugin` interface + `SimpleRAGPlugin` (file-keyword retriever) — auto-injected via `collect_context` | [10](./docs/10-rag.md) |
| [`@walle-agent/trace`](./packages/trace) | `TracePlugin` + `JSONLTraceStore` + `InMemoryTraceStore`; redaction, sampling, custom-store injection | [16](./docs/16-trace.md) |

External adapters that don't ship in this repo:
`@walle-agent/rag-qdrant`, `@walle-agent/trace-otel`. Both implement the same
plugin interfaces from this repo.

---

## Quick start

### A minimal agent with one tool

```ts
import { Agent, defineTool } from "@walle-agent/core";
import { OpenAIProvider } from "@walle-agent/openai";

const calculator = defineTool({
  name: "calculator",
  description: "Evaluate a math expression.",
  parameters: {
    type: "object",
    properties: { expression: { type: "string" } },
    required: ["expression"],
  },
  riskLevel: "low",
  async execute({ expression }: { expression: string }) {
    return { result: Function(`"use strict"; return (${expression})`)() };
  },
});

const agent = await Agent.create({
  name: "BasicAgent",
  model: new OpenAIProvider({ model: "gpt-4o-mini", apiKey: process.env.API_KEY! }),
  systemPrompt: "Use the calculator when needed.",
  tools: [calculator],
});

console.log((await agent.run("What is 42 * 17 + 3?")).content);
```

### Streaming

```ts
const stream = agent.run("Tell me a joke", { stream: true });
for await (const ev of stream) {
  if (ev.type === "text_delta") process.stdout.write(ev.content);
}
```

### Sandbox + permissions

```ts
import { SandboxPlugin } from "@walle-agent/sandbox";

const agent = await Agent.create({
  name: "Ops",
  model,
  permissions: {
    mode: "ask",
    requireApprovalFor: { shell: true, riskLevel: ["high"] },
    approvalHandler: async (req) => {
      console.log(`approve ${req.tool.name}?`, req.call.arguments);
      return true;
    },
  },
  plugins: [
    new SandboxPlugin({
      type: "local",
      local: { cwd: "./workspace", allowedCommands: ["ls", "cat", "echo"] },
    }),
  ],
  useBuiltinTools: { excludeTools: ["bash"] }, // prefer the sandboxed `shell`
});
```

### Multi-agent team

```ts
import { createSupervisorTeam } from "@walle-agent/team";

const team = await createSupervisorTeam({
  members: [
    { name: "Researcher", agent: researcher, role: "look up runbooks" },
    { name: "Triage", agent: triage, role: "produce a 3-step checklist" },
  ],
  coordinator: { model },
});

const out = await team.run("Customer reports checkout failure", { strategy: "supervisor" });
```

A complete end-to-end example wiring **every** plugin into one agent lives at
[`examples/walle-complete.ts`](./examples/walle-complete.ts):

```bash
pnpm complete                  # base demo
WALLE_DEMO_MCP=1 pnpm complete # also starts the filesystem MCP server
```

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  @walle-agent/core                                                 │
│  ┌──────────────┐   ┌────────────┐   ┌────────────────────────┐    │
│  │   Agent      │ ─▶│ AgentRun   │──▶│ LLMProvider.stream()   │    │
│  │   .run()     │   │  loop      │   │  (OpenAI / Anthropic)  │    │
│  └──────┬───────┘   └─────┬──────┘   └────────────────────────┘    │
│         │                 │                                        │
│         ▼                 ▼                                        │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐            │
│  │ ToolRegistry │   │   EventBus   │   │ Permissions  │            │
│  └──────────────┘   └──────┬───────┘   └──────────────┘            │
│                            │                                       │
│             collect_context│collect_messages                       │
│                            ▼                                       │
└────────────────────────────┼───────────────────────────────────────┘
                             │
              ┌──────────────┼─────────────────┬─────────────────┐
              ▼              ▼                 ▼                 ▼
         memory plugin  skills plugin     rag plugin      trace plugin
              │              │                 │                 │
              ▼              ▼                 ▼                 ▼
       ┌────────────┐ ┌────────────┐   ┌────────────┐   ┌────────────┐
       │ JSONL log  │ │ SKILL.md   │   │ chunks +   │   │ JSONL or   │
       │ + long     │ │ catalog    │   │ keyword    │   │ in-mem     │
       │ memory     │ │            │   │ retrieval  │   │ trace      │
       └────────────┘ └────────────┘   └────────────┘   └────────────┘

       sandbox plugin → registers `shell` (LocalSandbox / DockerSandbox)
       mcp plugin     → bridges MCP servers as native tools
       team package   → AgentTeam / Swarm / createSubAgentTool (top-level)
       evolution      → reads memory + tool calls, queues Skill / Memory proposals
```

The runtime is intentionally small: every cross-cutting concern (memory, skills,
RAG, tracing, sandboxing, permissions) is delivered through `WallePlugin.install()`
and the typed `EventBus`. Read [`docs/01-architecture.md`](./docs/01-architecture.md)
for the long form.

---

## Self-evolution loop

```
                                 ┌────────────────────────┐
   user says "remember X" ─────▶ │ EvolutionEngine        │
                                 │   • explicit remember  │
                                 │   • periodic review    │ ◀── EventBus
                                 │   • post-task review   │     (run_end)
                                 └──────────┬─────────────┘
                                            │
                            MemoryProposal / SkillProposal
                                            │
                                            ▼
                                ┌──────────────────────────┐
                                │ ProposalFileStore        │
                                │  ./.walle/evolution/…    │
                                └──────────┬───────────────┘
                                           │  approveAndApply()
                                           ▼
                              MemoryManager.write()  /  SkillRegistry.register()
```

Three triggers (any combination via config), file-backed proposal queue, async
`onProposal` callback. The proposal queue survives restarts. Spec:
[`docs/15-self-evolution.md`](./docs/15-self-evolution.md).

---

## Examples

| Script | Demonstrates |
|---|---|
| `pnpm basic`    | Single tool, non-streaming |
| `pnpm stream`   | Streaming tokens + tool-call deltas |
| `pnpm thinking` | Anthropic extended thinking |
| `pnpm memory`   | Session log + long-term recall across two runs |
| `pnpm evolution` | Memory + skill proposal extraction |
| `pnpm mcp`      | Filesystem MCP server via stdio |
| `pnpm rag`      | `SimpleRAGPlugin` + auto-inject |
| `pnpm trace`    | JSONL trace store + replay |
| `pnpm complete` | All plugins wired into one agent (see [`examples/walle-complete.ts`](./examples/walle-complete.ts)) |

Each example reads `examples/.env`:

```env
API_KEY=sk-xxx
BASE_URL=https://api.openai.com/v1   # or any OpenAI-compatible endpoint
MODEL=gpt-4o-mini
```

---

## Roadmap

| Phase | Slice | Status |
|---|---|---|
| 1 | Core Runtime (Agent, streaming, tools, hooks, middleware, providers) | ✅ |
| 2 | Memory + Skills + Evolution | ✅ |
| 3 | MCP + Permissions + Sandbox | ✅ |
| 4 | Team & Collaboration | ✅ |
| 5 | RAG + Trace + Polish | ✅ |
| 6 | Advanced Evolution (offline trace mining, embeddings, code-skill executor, …) | ⏭ Planned |

Per-phase plans live under [`plans/`](./plans/); the canonical roadmap is
[`docs/18-roadmap.md`](./docs/18-roadmap.md).

**MVP is complete.** 11 packages, 41 test files, 321 tests passing on the
current branch.

---

## Repo layout

```
walle-agent/
├── packages/                    # 11 SDK packages, peer-dep on @walle-agent/core
│   ├── core/                    # micro-core: Agent, runtime, events, tools, …
│   ├── openai/  anthropic/      # LLM providers
│   ├── memory/  skills/  evolution/   # self-evolution stack
│   ├── mcp/  sandbox/  permissions    # external tools + safety
│   ├── team/                    # multi-agent orchestration
│   └── rag/  trace/             # knowledge + observability
├── examples/                    # runnable demos (see table above)
├── docs/                        # spec-driven design (INDEX.md → 01..20)
└── plans/                       # per-slice requirements / design / tasks / testing
```

---

## Development

```bash
pnpm install
pnpm test            # vitest, all packages
pnpm build           # tsup, all packages
pnpm --filter @walle-agent/core test
```

The repo follows **Spec-Driven Development**: read the relevant `docs/*.md`
before changing a package; record any deviation in the spec's
"实现备忘 / Implementation notes" section. See [`CLAUDE.md`](./CLAUDE.md) for
the full project rule set.

---

## License

MIT
