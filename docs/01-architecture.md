# 01 — Architecture

## 总体架构

Walle Agent SDK 采用 **微核心 + 插件体系** 架构。核心只提供最小化的 Agent 运行时，所有扩展能力通过插件注入。

```
┌──────────────────────────────────────────────────────────────────┐
│                     @walle-agent/core                             │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Agent API                                                  │  │
│  │  - Agent.create() / agent.run() / agent.run({stream})       │  │
│  ├────────────────────────────────────────────────────────────┤  │
│  │  Runtime Engine                                             │  │
│  │  - Execution Loop (streaming-aware)                         │  │
│  │  - Tool Call Orchestrator                                   │  │
│  │  - Plugin Lifecycle Manager                                 │  │
│  │  - EventBus (typed, async)                                  │  │
│  ├────────────────────────────────────────────────────────────┤  │
│  │  Extension Points                                           │  │
│  │  - Hooks (side-effect listeners)                            │  │
│  │  - Middleware (request/response transforms)                 │  │
│  │  - Plugin Interface                                         │  │
│  ├────────────────────────────────────────────────────────────┤  │
│  │  Primitives                                                 │  │
│  │  - Tool / ToolRegistry                                      │  │
│  │  - LLMProvider (chat + stream)                              │  │
│  │  - TokenBudget                                              │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
         │              │              │              │
         ▼              ▼              ▼              ▼
┌──────────┐  ┌──────────────┐  ┌───────────┐  ┌────────────┐
│ @walle/  │  │ @walle/      │  │ @walle/   │  │ @walle/    │
│ memory   │  │ evolution    │  │ mcp       │  │ skills     │
└──────────┘  └──────────────┘  └───────────┘  └────────────┘
         │              │              │              │
         ▼              ▼              ▼              ▼
┌──────────┐  ┌──────────────┐  ┌───────────┐  ┌────────────┐
│ @walle/  │  │ @walle/      │  │ @walle/   │  │ @walle/    │
│ rag      │  │ sandbox      │  │ team      │  │ trace      │
└──────────┘  └──────────────┘  └───────────┘  └────────────┘
         │              │
         ▼              ▼
┌──────────┐  ┌──────────────┐
│ @walle/  │  │ @walle/      │
│ openai   │  │ anthropic    │
└──────────┘  └──────────────┘
```

---

## 核心分层原则

### Layer 0: Core Runtime（@walle-agent/core）

**职责**：Agent 生命周期管理、执行循环、Tool 调度、事件分发、流式控制。

**设计约束**：
- 零外部依赖（除 TypeScript 类型）
- 不绑定任何 LLM 厂商
- 不绑定任何存储实现
- 所有扩展通过 Plugin interface 接入

### Layer 1: Provider Plugins（LLM 适配层）

每个 LLM 厂商一个独立包，实现 `LLMProvider` 接口。

### Layer 2: Capability Plugins（能力层）

Memory、Skills、MCP、RAG、Sandbox、Evolution、Team 等，每个是独立 npm 包。

### Layer 3: Integration Plugins（集成层）

Trace（OTEL/Langfuse）、Gateway（HTTP/WebSocket）等外部系统集成。

---

## 核心设计原则

```
1. 微核心：core 包 < 50KB gzipped，只含运行时必需逻辑
2. 插件第一：所有能力通过 Plugin interface 注入，包括 Memory 和 Evolution
3. 流式原生：执行循环以 streaming 为第一公民，非流式是 stream 的 collect
4. 类型安全：所有 public API 强类型，泛型支持自定义 Tool input/output
5. 事件驱动：EventBus 贯穿全链路，Hooks/Trace/Evolution 都基于事件
6. Token 预算：内置 context window 管理，各插件通过预算竞争有限上下文
7. 可审计进化：自进化不是魔法，是 observe → propose → approve → apply 的工程管线
8. 开箱即用：默认提供 FileStore，无需安装数据库即可开发
9. 渐进增强：最简场景只需 core + 一个 provider，复杂场景逐步加插件
10. Node.js 优先：不做浏览器兼容，充分利用 fs/child_process/Worker 等系统能力
```

---

## Plugin Interface

所有插件遵循统一接口：

```ts
export interface WallePlugin {
  name: string;
  version?: string;

  /**
   * 插件初始化，在 Agent.create() 时调用。
   * 可注册 tools、hooks、middleware。
   */
  install(agent: AgentContext): Promise<void> | void;

  /**
   * 插件销毁，在 agent.dispose() 时调用。
   */
  dispose?(): Promise<void> | void;
}

export interface AgentContext {
  readonly agent: Agent;
  readonly config: AgentConfig;
  readonly events: EventBus;

  registerTool(tool: Tool): void;
  registerHook<K extends keyof AgentHooks>(name: K, handler: AgentHooks[K]): void;
  registerMiddleware(middleware: Middleware): void;

  getPlugin<T extends WallePlugin>(name: string): T | undefined;
}
```

---

## 关键交互流

```
User Input
  │
  ├─ [Middleware.beforeInput] ─── 可修改/拒绝输入
  │
  ├─ [Event: run_start]
  │
  ├─ [Plugin: Memory] ─── 检索相关记忆
  ├─ [Plugin: Skills] ─── 检索相关 Skill
  ├─ [Plugin: RAG] ──── 检索知识库
  │
  ├─ [TokenBudget] ──── 分配各模块 token 配额
  │
  ├─ [PromptBuilder] ── 组装最终 prompt
  │
  ├─ [LLM.chat / LLM.stream]
  │     │
  │     ├─ [Event: model_call_start]
  │     ├─ [StreamEvent: text_delta / tool_call_delta ...]
  │     ├─ [Event: model_call_end]
  │     │
  │     └─ if tool_calls:
  │           ├─ [Permission Check]
  │           ├─ [Event: tool_call_start]
  │           ├─ [Tool.execute / Sandbox.run]
  │           ├─ [Event: tool_call_end]
  │           └─ loop back to LLM
  │
  ├─ [Event: run_end]
  │
  ├─ [Plugin: Evolution] ─── afterRun review
  │
  ├─ [Middleware.afterOutput] ─── 可修改输出
  │
  └─ Return AgentResult | yield StreamEvents
```
