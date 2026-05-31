# 02 — Package Structure

## 包划分

采用 monorepo（pnpm workspace），微核心 + 插件体系。

### 核心原则

- `@walle-agent/core` 必须零外部依赖（仅 devDependency 有 TypeScript）
- 每个插件包独立发布，独立版本号
- 插件间可以有 peerDependency 关系（如 `@walle-agent/evolution` peer-depends `@walle-agent/memory`）
- 用户按需安装

---

## 包清单

| 包名 | 描述 | 依赖 |
|------|------|------|
| `@walle-agent/core` | 微核心：Agent、Runtime、Tool、Hooks、Middleware、EventBus、TokenBudget | 无外部依赖 |
| `@walle-agent/openai` | OpenAI LLM Provider | `openai` |
| `@walle-agent/anthropic` | Anthropic LLM Provider | `@anthropic-ai/sdk` |
| `@walle-agent/memory` | 分层记忆系统 + FileStore 实现 | core |
| `@walle-agent/skills` | Skill 系统 + FileStore 实现 | core |
| `@walle-agent/mcp` | MCP 协议集成 | `@modelcontextprotocol/sdk` |
| `@walle-agent/evolution` | 自进化引擎 | core, memory, skills |
| `@walle-agent/rag` | RAG 插件接口 + 基础实现 | core |
| `@walle-agent/sandbox` | 沙箱执行环境 | `execa` |
| `@walle-agent/team` | 多 Agent 协作（Team/Swarm） | core |
| `@walle-agent/trace` | Observability（OTEL/JSONL） | core |
| `@walle-agent/permissions` | 权限策略（可独立或内置 core） | core |

---

## 目录结构

```
walle-agent/
├── package.json                    # workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── docs/                           # 本 spec 文档
│
├── packages/
│   ├── core/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts            # public API re-exports
│   │       ├── agent.ts            # Agent class
│   │       ├── agent-config.ts     # AgentConfig type
│   │       ├── agent-runtime.ts    # AgentRuntime (execution loop)
│   │       ├── agent-context.ts    # AgentContext (plugin interface)
│   │       ├── events.ts           # EventBus + event types
│   │       ├── stream.ts           # StreamEvent types + helpers
│   │       ├── tool.ts             # Tool interface
│   │       ├── tool-registry.ts    # ToolRegistry
│   │       ├── tool-executor.ts    # ToolCallExecutor
│   │       ├── llm-provider.ts     # LLMProvider interface
│   │       ├── message.ts          # ModelMessage + ContentBlock
│   │       ├── hooks.ts            # AgentHooks types + HookManager
│   │       ├── middleware.ts       # Middleware + MiddlewarePipeline
│   │       ├── plugin.ts           # WallePlugin interface
│   │       ├── token-budget.ts     # TokenBudget manager
│   │       ├── prompt-builder.ts   # PromptBuilder
│   │       └── types.ts            # shared utility types
│   │
│   ├── openai/
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── openai-provider.ts
│   │       └── message-adapter.ts  # OpenAI ↔ internal message conversion
│   │
│   ├── anthropic/
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── anthropic-provider.ts
│   │       └── message-adapter.ts  # Anthropic ↔ internal message conversion
│   │
│   ├── memory/
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── memory-plugin.ts    # WallePlugin implementation
│   │       ├── memory-manager.ts
│   │       ├── memory-types.ts
│   │       ├── short-term.ts
│   │       ├── file-store.ts       # JSONL-based store
│   │       ├── memory-extractor.ts # LLM-based memory extraction
│   │       └── memory-query.ts
│   │
│   ├── skills/
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── skills-plugin.ts
│   │       ├── skill-types.ts
│   │       ├── skill-registry.ts
│   │       ├── skill-retriever.ts
│   │       ├── skill-executor.ts
│   │       └── file-store.ts       # JSON-based skill store
│   │
│   ├── mcp/
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── mcp-plugin.ts
│   │       ├── mcp-client-manager.ts
│   │       ├── mcp-tool-adapter.ts
│   │       └── mcp-config.ts
│   │
│   ├── evolution/
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── evolution-plugin.ts
│   │       ├── evolution-engine.ts
│   │       ├── memory-reviewer.ts
│   │       ├── skill-reviewer.ts
│   │       ├── proposal-queue.ts   # pending approval queue
│   │       ├── explicit-remember.ts
│   │       └── periodic-review.ts
│   │
│   ├── rag/
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── rag-plugin.ts
│   │       ├── rag-types.ts
│   │       └── simple-retriever.ts # basic file-based retriever
│   │
│   ├── sandbox/
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── sandbox-plugin.ts
│   │       ├── sandbox-types.ts
│   │       ├── local-sandbox.ts
│   │       └── docker-sandbox.ts
│   │
│   ├── team/
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── team-plugin.ts
│   │       ├── agent-team.ts
│   │       ├── swarm.ts
│   │       ├── coordinator.ts
│   │       └── blackboard.ts
│   │
│   └── trace/
│       ├── package.json
│       └── src/
│           ├── index.ts
│           ├── trace-plugin.ts
│           ├── trace-types.ts
│           ├── jsonl-store.ts
│           └── otel-adapter.ts
│
└── examples/
    ├── basic-agent.ts
    ├── streaming.ts
    ├── mcp-agent.ts
    ├── memory-evolution.ts
    ├── team-collaboration.ts
    └── full-featured.ts
```

---

## pnpm-workspace.yaml

```yaml
packages:
  - "packages/*"
  - "examples"
```

---

## 包间依赖关系

```
core (no deps)
  ↑
  ├── openai
  ├── anthropic
  ├── memory
  ├── skills
  ├── mcp
  ├── rag
  ├── sandbox
  ├── team
  ├── trace
  │
  └── evolution
        ↑ peerDeps: memory, skills
```

---

## 发布策略

- 使用 [changesets](https://github.com/changesets/changesets) 管理版本
- 各包独立版本号（非 lock-step）
- core 的 breaking change 会触发所有插件包 major bump
- 预发布阶段使用 `0.x` 版本号
