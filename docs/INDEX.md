# Walle Agent SDK — Specification Index

> TypeScript 通用 Agent SDK：微核心 + 插件体系 + 自进化闭环

## 设计决策

| 决策项 | 选择 |
|--------|------|
| 运行环境 | Node.js only |
| 流式输出 | `run()` overload，可选 stream 参数 |
| SDK 定位 | 开发者 SDK（npm 库） |
| 自进化优先级 | MVP 核心卖点 |
| LLM Provider | OpenAI + Anthropic |
| 默认存储 | 文件系统 JSON/JSONL |
| 包结构 | 微核心 + 插件体系 |

---

## 规格文档目录

| # | 文档 | 说明 |
|---|------|------|
| 01 | [Architecture](./01-architecture.md) | 总体架构、分层、设计原则 |
| 02 | [Package Structure](./02-package-structure.md) | 微核心 + 插件包划分与目录结构 |
| 03 | [Core Runtime](./03-core-runtime.md) | Agent、AgentRuntime、执行循环、EventBus |
| 04 | [Streaming](./04-streaming.md) | 流式设计、StreamEvent 类型、全链路 streaming |
| 05 | [LLM Provider](./05-llm-provider.md) | Provider 抽象、多模态消息、OpenAI/Anthropic/兼容层 |
| 06 | [Tools](./06-tools.md) | Tool 接口、ToolRegistry、执行上下文 |
| 07 | [MCP Integration](./07-mcp.md) | MCP 协议集成、Transport 适配、Tool 桥接 |
| 08 | [Skills](./08-skills.md) | Skill 系统、类型分类、Registry、检索 |
| 09 | [Memory](./09-memory.md) | 分层记忆、MemoryStore 接口、文件存储实现 |
| 10 | [RAG](./10-rag.md) | RAG 插件接口、知识库设计 |
| 11 | [Sandbox](./11-sandbox.md) | 沙箱抽象、Local/Docker 实现 |
| 12 | [Hooks & Middleware](./12-hooks-middleware.md) | 生命周期 Hooks、Middleware Pipeline |
| 13 | [Permissions & Security](./13-permissions.md) | 权限策略、Tool 风险等级、审批流程 |
| 14 | [Team & Swarm](./14-team-swarm.md) | 子 Agent、AgentTeam、Swarm、Coordinator |
| 15 | [Self-Evolution](./15-self-evolution.md) | 自进化引擎、记忆沉淀、Skill 提取、审批队列 |
| 16 | [Trace & Observability](./16-trace.md) | TraceEvent、EventBus、OTEL 适配 |
| 17 | [Token Budget](./17-token-budget.md) | Context Window 管理、模块预算分配 |
| 18 | [Roadmap](./18-roadmap.md) | 实现路线图（已修正阶段划分） |
| 19 | [Plugin System](./19-plugin-system.md) | Plugin 接口、AgentContext、生命周期 |
| 20 | [Built-in Tools](./20-builtin-tools.md) | 内置工具（core 自动注册）：文件系统、Shell、Plan、Task Management |
| 21 | [Context Compression](./21-context-compression.md) | Micro（按 turn 逐出 tool result）+ Macro（对话摘要）双层压缩 |
| 22 | [Tool Search](./22-tool-search.md) | ToolRegistry shadow + `tool_search` / `defer_execute_tool` 内置工具 |

---

## Quick Start（目标 API）

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
  // 内置工具 (ls, read_file, write_file, edit_file, glob, grep, bash, plan, write_todos, task, web_fetch)
  // 默认全部启用，无需配置
});

// 非流式；传入 sessionId 让消息持久化并跨 run 回放
const result = await agent.run("帮我总结这个文件", { sessionId: "user-42" });

// 流式
for await (const event of agent.run("帮我总结这个文件", { stream: true, sessionId: "user-42" })) {
  if (event.type === "text_delta") process.stdout.write(event.content);
}
```
