# Sub-Agents — Design

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│ @walle-agent/core                                                       │
│                                                                         │
│  AgentConfig                                                            │
│   ├─ subAgents?: SubAgentDefinition[]    ← new sugar field              │
│   └─ ...                                                                │
│                                                                         │
│  SubAgentRegistry            ← new                                      │
│   ├─ register(def)                                                      │
│   ├─ get(type) / has / list / types                                     │
│   └─ private map: Map<string, SubAgentDefinition>                       │
│                                                                         │
│  builtin-tools/task-tool.ts  ← new                                      │
│   └─ createTaskTool({ registry, defaultModel }) → Tool                  │
│       execute({ subagent_type, description, prompt }, ctx):             │
│         def = registry.get(subagent_type)                               │
│         if !def → return { error, available: registry.types() }         │
│         child = await Agent.create({                                    │
│           name: `${parent.name}/${def.type}`,                           │
│           model: def.model ?? defaultModel ?? parent.model,             │
│           systemPrompt: def.systemPrompt,                               │
│           tools: def.tools,                                             │
│           useBuiltinTools: def.useBuiltinTools ?? false,                │
│           plugins: def.plugins,                                         │
│           maxTurns: def.maxTurns,                                       │
│           sessionId: def.inheritSession ? parent.sessionId : undefined, │
│         })                                                              │
│         try { result = await child.run(prompt, { signal }) }            │
│         finally { await child.dispose() }                               │
│         return def.verbose                                              │
│           ? { result: result.content, messages, toolCalls }             │
│           : { result: result.content }                                  │
│                                                                         │
│  AgentRuntime.init():                                                   │
│   ├─ build per-agent SubAgentRegistry from config.subAgents             │
│   ├─ register built-in task tool with registry + parent model           │
│   └─ register other built-in tools as before                            │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ @walle-agent/team                                                       │
│                                                                         │
│  SubAgentsPlugin   ← new                                                │
│   ├─ install(ctx):                                                      │
│   │   ├─ registry = new SubAgentRegistry()                              │
│   │   ├─ for def of options.types: registry.register(def)               │
│   │   └─ ctx.registerTool(createTaskTool({ registry,                    │
│   │                                        defaultModel: ctx.config.model })) │
│   └─ getRegistry(): SubAgentRegistry  // for tests / advanced use       │
│                                                                         │
│  (existing) createSubAgentTool(agent, options?)                         │
│   ── stays as the "static wrapper" path; orthogonal to task             │
└─────────────────────────────────────────────────────────────────────────┘
```

## Task tool input schema

```ts
parameters: {
  type: "object",
  properties: {
    subagent_type: {
      type: "string",
      description:
        "Type of sub-agent to dispatch. Available types: ${types.join(', ') || '(none registered)'}",
    },
    description: {
      type: "string",
      description: "Short (3-5 word) summary of what the sub-agent will do.",
    },
    prompt: {
      type: "string",
      description: "The actual task to send to the sub-agent.",
    },
  },
  required: ["subagent_type", "description", "prompt"],
}
```

> Note: `description` 字段在 LLM tool schema 里**动态枚举**当前已注册类型——
> 因此 task 工具不能是「全局单例」,必须**每个 Agent 实例化一份**(已在 AgentRuntime.init 里这样做)。

## Conflict resolution: AgentConfig.subAgents vs SubAgentsPlugin

允许同时使用——AgentRuntime 创建一份 registry,SubAgentsPlugin 注册到**同一份 registry**(通过 `ctx.config` 暴露)。但实现简化优先:

- v1 实现:**互斥**——若 `config.subAgents` 非空且 `SubAgentsPlugin` 也存在,plugin 在 install 时检测到 `config.subAgents.length > 0` 直接抛错,提示用户二选一。
- 这样避免重复注册同 type 时的难调 bug。
- 后续若有强需求再放宽。

## Module layout

```
packages/core/src/
├── sub-agent-registry.ts       new
├── builtin-tools/
│   ├── task-tool.ts            new
│   └── index.ts                update: export createTaskTool, add to BUILTIN_TOOLS
├── agent-config.ts             update: add subAgents field
├── agent-runtime.ts            update: build registry, instantiate task tool
└── index.ts                    update: export SubAgentRegistry, createTaskTool, types

packages/team/src/
├── sub-agents-plugin.ts        new
└── index.ts                    update: export SubAgentsPlugin
```

## Key implementation choices

### 1. Per-Agent task tool instance(不是 BUILTIN_TOOLS 里的静态实例)

`task` 工具的入参 schema 必须把当前已注册类型枚举到 `description` 里(让 LLM 知道有哪些 type 可选)。所以它**不能**和 `lsTool` / `bashTool` 那样是 module-level singleton。

实现:在 `BUILTIN_TOOLS` 数组里**不**包含 task 工具;`AgentRuntime.registerBuiltinTools()` 里**单独**根据当前 agent 的 registry 构造 task tool 后注册。

### 2. sub-agent dispose 时机

`task.execute()` 用 `try/finally` 保证每次调用都 `await child.dispose()`,避免 plugin 资源泄漏(memory plugin 关 fd、mcp plugin 断连接等)。

### 3. signal propagation

`task.execute(input, ctx)` 拿到 `ctx.signal`,调 `child.run(prompt, { signal: ctx.signal })`。父 abort → child 跟着 abort,无需额外 hook。

### 4. session 隔离

默认 `inheritSession: false` → `Agent.create` 里 `sessionId` 由内部 `newUuid()` 生成,memory plugin 写到独立目录;不污染父会话历史。

`inheritSession: true` → 把 `parent.sessionId` 传给 child,memory plugin 复用同一 session 文件——给"sub-agent 接着父 Agent 思路想"的高级用法保留入口。

### 5. 默认 useBuiltinTools: false 的理由

防递归。若 sub-agent 默认拿到 task 工具,LLM 很容易写出"sub-agent 再 task 出 sub-sub-agent"的死循环。Claude Code 实际行为也是 sub-agent 默认无 Task 工具。

### 6. AgentConfig.subAgents 在 ResolvedAgentConfig 里也保留

```ts
interface ResolvedAgentConfig {
  // ...
  subAgents: SubAgentDefinition[];  // 默认 []
}
```

便于 AgentRuntime / 未来的 hook 访问。

## Public API surface

```ts
// @walle-agent/core
export { SubAgentRegistry } from "./sub-agent-registry.js";
export type { SubAgentDefinition } from "./sub-agent-registry.js";
export { createTaskTool } from "./builtin-tools/task-tool.js";
export type { TaskToolInput, TaskToolOutput } from "./builtin-tools/task-tool.js";

// @walle-agent/team
export { SubAgentsPlugin } from "./sub-agents-plugin.js";
export type { SubAgentsPluginOptions } from "./sub-agents-plugin.js";
```

## Backward compat

- **不破现有 API**:既有 `createSubAgentTool` / `AgentTeam` / `Swarm` 路径完全不变。
- 新加的 `subAgents` 字段是可选的;不传 → 行为和今天完全一样,只是 `task` 工具会注册但 `available: []`。
- 用户不想要 task 工具:`useBuiltinTools: { excludeTools: ["task"] }` 即可关闭。
