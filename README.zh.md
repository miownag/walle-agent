# Walle Agent SDK

> [English](./README.md) · **中文**

一个 TypeScript Agent SDK，采用**微核心 + 插件**架构，并自带**自进化**闭环。
用同一套可组合的运行时，构建会记忆、能演进技能、可在沙箱里执行 shell、
能从知识库检索、可编排多 Agent 协作、并且全程留下审计日志的智能体。

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

const result = await agent.run("帮我总结一下部署 runbook", {
  sessionId: "user-42",
});
```

---

## 为什么选 Walle

| 特性 | 你能得到什么 |
|---|---|
| **微核心** | 运行时只有 `Agent` + `EventBus` + `ToolRegistry` + 插件钩子。memory / skills / sandbox / RAG / trace / team 全部以可选包形式发布。 |
| **自进化** | 内置三条触发链：显式 `remember` 工具、周期复盘、任务后技能提取 → 落地为文件队列 + 审批回调。 |
| **流式优先** | 同一个 `agent.run(...)`，传 `{ stream: true }` 返回 `AgentStream`，否则返回 `Promise<AgentResult>`。 |
| **可中断 + 续跑** | `agent.interrupt()` 协作式取消；被中断的 tool 输出会在 `Agent.resume(sessionId, ...)` 时完整重放。 |
| **权限策略** | 一等公民：`mode`、`allowTools`、`denyTools`、`requireApprovalFor: { riskLevel, fileWrite, network, shell }`、异步 `approvalHandler`。 |
| **沙箱执行** | `LocalSandbox`（execa）和 `DockerSandbox`，注册成 `shell` 工具，复用同一套风险标签。 |
| **多 Agent** | `AgentTeam`(parallel / pipeline / debate / supervisor)、`Swarm` + `SwarmPolicy`、`Blackboard`、`createSubAgentTool`,以及对齐 Claude Code 的内置 **`task` 工具**(动态调度子 Agent)。 |
| **上下文压缩** | 长 run 的两层防护：**micro** 把更早的 `role:"tool"` 消息改写成占位符（落盘到 vault，可用 `read_tool_result` 取回）；**macro** 在轮间或通过 `agent.compact()` 把头部对话总结成一条消息。 |
| **Tool Search** | 工具数过多时,默认 shadow 掉带 `mcp` tag 的工具,通过两个内置工具暴露:`tool_search`(关键词 + 正则,带评分)和 `defer_execute_tool`(走 underlying tool 的权限策略调度任意已注册工具)。 |
| **审计日志** | `TracePlugin` 写 JSONL 或内存；通过 `customStore` 注入即可对接 OTEL。 |
| **Spec-Driven** | 每个包的设计沉淀在 [`docs/`](./docs/INDEX.md)，每个切片的实现备忘沉淀在 [`plans/`](./plans/)。 |

---

## 安装

```bash
pnpm add @walle-agent/core @walle-agent/openai
# 按需安装插件：
pnpm add @walle-agent/memory @walle-agent/skills @walle-agent/evolution
pnpm add @walle-agent/sandbox @walle-agent/permissions
pnpm add @walle-agent/mcp @walle-agent/rag @walle-agent/trace @walle-agent/team
```

要求 **Node.js ≥ 20**，ESM 优先（同时提供 CJS 产物）。

---

## 包列表

| 包 | 作用 | 规格 |
|---|---|---|
| [`@walle-agent/core`](./packages/core) | Agent、运行时、事件总线、工具注册表、Hooks、Middleware、权限、内置工具 | [03](./docs/03-core-runtime.md) · [12](./docs/12-hooks-middleware.md) · [13](./docs/13-permissions.md) · [20](./docs/20-builtin-tools.md) |
| [`@walle-agent/openai`](./packages/openai) | OpenAI / OpenAI 兼容协议，支持流式 + tool-calls | [05](./docs/05-llm-provider.md) |
| [`@walle-agent/anthropic`](./packages/anthropic) | Anthropic provider，支持流式 + extended thinking | [05](./docs/05-llm-provider.md) |
| [`@walle-agent/memory`](./packages/memory) | 会话日志（JSONL）、长期记忆、ToolResultVault、`remember` / `recall` / `forget` 工具 | [09](./docs/09-memory.md) |
| [`@walle-agent/skills`](./packages/skills) | 模仿 `.claude/skills` 的 SOP 目录、project + user 双 scope、自动注入 system prompt | [08](./docs/08-skills.md) |
| [`@walle-agent/evolution`](./packages/evolution) | Memory + Skill 提取引擎、文件落盘的提案队列、审批回调 | [15](./docs/15-self-evolution.md) |
| [`@walle-agent/mcp`](./packages/mcp) | MCP 客户端管理、stdio + Streamable-HTTP 双 transport、工具白/黑名单 | [07](./docs/07-mcp.md) |
| [`@walle-agent/sandbox`](./packages/sandbox) | `Sandbox` 接口、`LocalSandbox`（execa）、`DockerSandbox`、`shell` 工具注册 | [11](./docs/11-sandbox.md) |
| [`@walle-agent/team`](./packages/team) | `AgentTeam`（parallel / pipeline / debate / supervisor）、`Swarm`、`Blackboard`、`createSubAgentTool`、`createSupervisorTeam`、`SubAgentsPlugin` | [14](./docs/14-team-swarm.md) |
| [`@walle-agent/rag`](./packages/rag) | `RAGPlugin` 接口 + `SimpleRAGPlugin`（文件 + 关键词检索），通过 `collect_context` 自动注入 | [10](./docs/10-rag.md) |
| [`@walle-agent/trace`](./packages/trace) | `TracePlugin` + `JSONLTraceStore` + `InMemoryTraceStore`；redaction、采样、自定义 store 注入 | [16](./docs/16-trace.md) |

不在本仓库内的外部 adapter：`@walle-agent/rag-qdrant`、`@walle-agent/trace-otel`，
都实现本仓库定义的同一组插件接口。

---

## 快速开始

### 一个最小化、带工具的 Agent

```ts
import { z } from "zod";
import { Agent, defineTool } from "@walle-agent/core";
import { OpenAIProvider } from "@walle-agent/openai";

// `defineTool` 对齐 Claude Agent SDK 的 MCP 风格 `tool()` 签名:
// (name, description, zodShape, handler, extras?)。Zod raw shape 会自动派生
// 成 JSON Schema, handler 拿到的是 parse 后强类型的 args。
const calculator = defineTool(
  "calculator",
  "执行一个数学表达式。",
  { expression: z.string().describe("待求值的数学表达式") },
  async ({ expression }) => ({
    result: Function(`"use strict"; return (${expression})`)(),
  }),
  {
    riskLevel: "low",
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
);

const agent = await Agent.create({
  name: "BasicAgent",
  model: new OpenAIProvider({ model: "gpt-4o-mini", apiKey: process.env.API_KEY! }),
  systemPrompt: "需要计算时调用 calculator 工具。",
  tools: [calculator],
});

console.log((await agent.run("42 * 17 + 3 是多少？")).content);
```

### 流式

```ts
const stream = agent.run("讲个笑话", { stream: true });
for await (const ev of stream) {
  if (ev.type === "text_delta") process.stdout.write(ev.content);
}
```

### 沙箱 + 权限

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
  useBuiltinTools: { excludeTools: ["bash"] }, // 优先走沙箱版 `shell`
});
```

### 多 Agent 团队

```ts
import { createSupervisorTeam } from "@walle-agent/team";

const team = await createSupervisorTeam({
  members: [
    { name: "Researcher", agent: researcher, role: "查 runbook" },
    { name: "Triage", agent: triage, role: "产出 3 步排查清单" },
  ],
  coordinator: { model },
});

const out = await team.run("用户报告 checkout 失败", { strategy: "supervisor" });
```

### 动态子 Agent（对齐 Claude Code 的 `task` 工具）

预先注册子 Agent **类型**,父 Agent 通过内置的 `task` 工具动态调度。每次调用
临时实例化一个子 Agent,跑完即销毁,父 Agent 只看到最终总结,看不到中间
工具调用。

```ts
const agent = await Agent.create({
  name: "Walle",
  model,
  subAgents: [
    {
      type: "researcher",
      description: "Web research and concise summarization",
      systemPrompt: "你是研究专家……",
      tools: [webSearchTool],
    },
    { type: "code-reviewer", systemPrompt: "审查代码……" },
  ],
});

// 父 LLM 只看到一个 `task` 工具,这样调用:
//   { subagent_type: "researcher", description: "find X", prompt: "…" }
```

也可以走 `@walle-agent/team` 的 `SubAgentsPlugin` 插件形态,或直接用低层
`createTaskTool({ registry, defaultModel })` factory——详见
[`docs/14-team-swarm.md`](./docs/14-team-swarm.md#dynamic-subagenttask-工具)。

### 上下文压缩(micro + macro)

两层机制约束长 run 的 token 体量。Micro 默认随 `MemoryPlugin` 启用;Macro 是 opt-in。

```ts
const agent = await Agent.create({
  name: "Walle",
  model,
  plugins: [
    new MemoryPlugin({
      rootDir: "./.walle",
      toolResults: { keepRecentTurns: 3 },     // micro:最近 N 轮保留原文
    }),
  ],
  macroCompression: {
    enabled: true,
    threshold: 0.8,                            // est tokens > 80% × maxContextTokens
    keepRecentTurns: 3,
  },
});

// 主动触发宏压缩
await agent.compact();
```

内置工具 `read_tool_result(toolCallId, offset?, limit?)` 可分页读取被逐出的 tool 结果。
规格见 [`docs/21-context-compression.md`](./docs/21-context-compression.md)。

### Tool Search(shadow registry + 动态发现)

工具数过多时(典型场景:挂多个 MCP server),Walle 默认把 MCP 工具放到 shadow,
通过两个内置工具按需暴露,避免每轮 LLM 调用塞 50+ 个工具的 JSON Schema。

```ts
const agent = await Agent.create({
  name: "Walle",
  model,
  plugins: [/* MCPPlugin 等 */],
  toolSearch: {
    enabled: true,                  // 默认值
    mode: "auto",                   // "auto" | "force" | "off"
    threshold: 30,                  // mode=auto 时:总数 > 30 才生效
    alwaysShadowTags: ["mcp"],
    alwaysActiveTags: ["builtin"],
  },
});

agent.listVisibleTools();           // 含 tool_search + defer_execute_tool
agent.listHiddenTools();            // 被 shadow 的 MCP 工具
```

规格见 [`docs/22-tool-search.md`](./docs/22-tool-search.md)。

把**所有**插件接到一个 Agent 上的端到端示例在
[`examples/walle-complete.ts`](./examples/walle-complete.ts):

```bash
pnpm complete                  # 基础演示
WALLE_DEMO_MCP=1 pnpm complete # 顺带启动 MCP 文件系统服务
```

---

## 架构

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
       │ JSONL 日志 │ │ SKILL.md   │   │ chunk +    │   │ JSONL 或   │
       │ + 长期    │ │ 目录       │   │ 关键词     │   │ 内存 trace │
       │ memory    │ │            │   │ 检索       │   │            │
       └────────────┘ └────────────┘   └────────────┘   └────────────┘

       sandbox plugin → 注册 `shell` 工具（LocalSandbox / DockerSandbox）
       mcp plugin     → 把 MCP server 的工具桥接为本地 Tool
       team package   → AgentTeam / Swarm / createSubAgentTool（顶层 API）
       evolution      → 读 memory + tool calls，把 Skill / Memory 提案入队
```

运行时刻意保持精简：所有横切关注点（memory / skills / RAG / trace / sandbox /
permissions）都通过 `WallePlugin.install()` 和强类型的 `EventBus` 接入。
完整长文见 [`docs/01-architecture.md`](./docs/01-architecture.md)。

---

## 自进化闭环

```
                                 ┌────────────────────────┐
   用户说 "记住 X" ──────────▶  │ EvolutionEngine        │
                                 │   • 显式 remember     │
                                 │   • 周期 review        │ ◀── EventBus
                                 │   • 任务后 review      │     (run_end)
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

三条触发链可任意组合，提案队列文件落盘并跨重启保活，配合异步
`onProposal` 回调。规格：[`docs/15-self-evolution.md`](./docs/15-self-evolution.md)。

---

## 示例

| 命令 | 演示内容 |
|---|---|
| `pnpm basic`    | 单工具、非流式 |
| `pnpm stream`   | Token 流 + tool-call delta |
| `pnpm thinking` | Anthropic extended thinking |
| `pnpm memory`   | 会话日志 + 跨 run 长期记忆召回 |
| `pnpm evolution` | Memory + Skill 提案抽取 |
| `pnpm mcp`      | 通过 stdio 接入 filesystem MCP server |
| `pnpm rag`      | `SimpleRAGPlugin` + 自动注入 |
| `pnpm trace`    | JSONL trace store + 回放 |
| `pnpm sub-agents` | 通过内置 `task` 工具动态调度子 Agent |
| `pnpm compaction` | 上下文压缩（micro + macro）演示 |
| `pnpm tool-search` | 60 个伪 MCP 工具自动 shadow，通过 `tool_search` 重新发现 |
| `pnpm complete` | 把所有插件接到一个 Agent 上（见 [`examples/walle-complete.ts`](./examples/walle-complete.ts)）|

每个示例读 `examples/.env`：

```env
API_KEY=sk-xxx
BASE_URL=https://api.openai.com/v1   # 或任何 OpenAI 兼容 endpoint
MODEL=gpt-4o-mini
```

---

## Roadmap

| Phase | 切片 | 状态 |
|---|---|---|
| 1 | Core Runtime（Agent、流式、工具、Hooks、Middleware、Provider）| ✅ |
| 2 | Memory + Skills + Evolution | ✅ |
| 3 | MCP + Permissions + Sandbox | ✅ |
| 4 | Team & Collaboration | ✅ |
| 5 | RAG + Trace + Polish | ✅ |
| 6 | 进阶进化（离线 trace 挖掘、Embedding 检索、Code-Skill executor 等）| ⏭ 计划中 |

每个 Phase 的实现记录在 [`plans/`](./plans/) 目录；权威 roadmap 是
[`docs/18-roadmap.md`](./docs/18-roadmap.md)。

**MVP 已完成**：11 个包，44 个测试文件，当前分支上 348 个测试全部通过。

---

## 仓库结构

```
walle-agent/
├── packages/                    # 11 个 SDK 包，peer-dep @walle-agent/core
│   ├── core/                    # 微核心：Agent、运行时、events、tools …
│   ├── openai/  anthropic/      # LLM provider
│   ├── memory/  skills/  evolution/   # 自进化栈
│   ├── mcp/  sandbox/  permissions    # 外部工具 + 安全
│   ├── team/                    # 多 Agent 编排
│   └── rag/  trace/             # 知识 + 可观测
├── examples/                    # 可运行的示例（见上方表格）
├── docs/                        # Spec-Driven 设计文档（INDEX.md → 01..20）
└── plans/                       # 每个切片的 requirements / design / tasks / testing
```

---

## 开发

```bash
pnpm install
pnpm test            # vitest 跑所有包
pnpm build           # tsup 构建所有包
pnpm --filter @walle-agent/core test
```

仓库遵循 **Spec-Driven Development**：改包之前先读对应的 `docs/*.md`，
有偏差时把它写到 spec 的"实现备忘 / Implementation notes"段落里。
完整工程规则见 [`CLAUDE.md`](./CLAUDE.md)。

---

## License

MIT
