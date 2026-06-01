# Sub-Agents — Requirements

## Why this slice

Walle 的 `@walle-agent/team` 已经支持「**静态包装**」:用 `createSubAgentTool(agent)`
把一个**已经存在的 Agent 实例**包装成 Tool;Coordinator 在编译期就知道有哪些
sub-agent,每个 sub-agent 一个独立的 `delegate_<slug>` 工具。

但 Claude Code 的 `Task` 工具语义是「**动态调度**」:

- LLM 只看到**一个**通用工具(`Task`),通过 `subagent_type` 入参选择类型;
- 每次调用**临时**实例化一个 sub-agent,跑完即销毁;
- sub-agent 有自己的 system prompt / tool 集 / model,由用户**预先注册类型**提供;
- 主 Agent 只看到 sub-agent 的最终总结,看不到中间步骤。

当前 walle 没有这种能力。本 slice 补齐它。

## Functional requirements

### F1 — 内置 `task` 工具(默认启用)

- 新增 `packages/core/src/builtin-tools/task-tool.ts`,加入 `BUILTIN_TOOLS` 数组。
- 入参:`{ subagent_type: string, description: string, prompt: string }`。
  - `subagent_type` — 已注册的 sub-agent 类型名(必填)。
  - `description` — 给主 Agent 看的短摘要(必填,3-5 词)。
  - `prompt` — 实际派发给 sub-agent 的任务(必填)。
- 输出:
  - 默认 `{ result: string }`(只回 sub-agent 的最终 content)。
  - 当注册时 `verbose: true` → `{ result: string, messages: ModelMessage[], toolCalls: ToolCallRecord[] }`。
- 未注册 type → 返回 `{ error, available: string[] }`,**不抛异常**(让 LLM 自我纠正)。
- `riskLevel: "low"`,默认无审批。

### F2 — `SubAgentRegistry`(类型注册表)

- 新增 `packages/core/src/sub-agent-registry.ts`,导出类 + 类型。
- API:
  ```ts
  class SubAgentRegistry {
    register(def: SubAgentDefinition): void;
    get(type: string): SubAgentDefinition | undefined;
    has(type: string): boolean;
    list(): SubAgentDefinition[];
    types(): string[];
  }

  interface SubAgentDefinition {
    type: string;                 // unique key, used as subagent_type
    description?: string;         // surfaced to parent LLM in task tool description
    systemPrompt?: string;
    model?: LLMProvider;          // default: inherit parent model
    tools?: Tool[];               // default: []
    useBuiltinTools?: boolean | BuiltinToolsConfig; // default: false (sub-agent 不自动拿父的内置工具集合)
    plugins?: WallePlugin[];      // default: []
    maxTurns?: number;            // default: parent agent's maxTurns
    verbose?: boolean;            // default: false
    inheritSession?: boolean;     // default: false (不串台 memory)
  }
  ```
- 重复 type 注册 → throw(避免静默覆盖)。

### F3 — `AgentConfig.subAgents` 糖语法

- `AgentConfig` 新增可选字段:
  ```ts
  subAgents?: SubAgentDefinition[];
  ```
- `Agent.create()` 时把数组喂进内部 `SubAgentRegistry`,task 工具使用该 registry。
- 不传 `subAgents` 时,task 工具仍然注册,但 `available: []`,任何 `subagent_type` 都返回错误——保留 type 安全语义,行为可预期。

### F4 — `@walle-agent/team` 提供 `SubAgentsPlugin`

- 新增 `packages/team/src/sub-agents-plugin.ts`。
- Plugin 形态等价于 F3 的糖语法,实现复用 core 的 `SubAgentRegistry` + `createTaskTool()`。
- 适用场景:用户已经在用 plugin 数组管理装配,不想用顶层 `subAgents` 字段。

### F5 — 导出 `createTaskTool` factory

- 给高级用户用:不走默认 built-in,自己拿 registry 实例 + factory 拼工具。
- 签名:
  ```ts
  function createTaskTool(opts: {
    registry: SubAgentRegistry;
    defaultModel?: LLMProvider;
  }): Tool;
  ```

### F6 — sub-agent 生命周期

- 每次 task 调用流程:
  1. `registry.get(subagent_type)` → `SubAgentDefinition`
  2. `Agent.create({ ...def, model: def.model ?? parent.model })`
  3. `agent.run(prompt, { signal: parentSignal })`
  4. `agent.dispose()`
- 父 Agent abort → 父 signal 透传给 sub-agent → sub-agent 也停。

### F7 — 防递归默认

- sub-agent 的 `useBuiltinTools` 默认 `false`(不自动给 task 工具)。
- 想做嵌套 sub-agent → 在 SubAgentDefinition 里显式 `useBuiltinTools: { includeTools: ["task"] }` 并提供自己的 `subAgents`(通过 plugin 或继承 registry)。

## Non-functional requirements

- **不破 core 零运行时依赖**:`SubAgentRegistry` 是纯 TS 类,task 工具内部只调 `Agent.create()` / `agent.run()` / `agent.dispose()`,无新外部依赖。
- 默认行为对齐 Claude Code:开箱即用,不需要 import 任何包。
- 全部用 mock LLMProvider 做单测,不接真模型。

## Out of scope (deferred)

- sub-agent 的 streaming output 透传到父 Agent(默认非流式;Phase 2 再考虑)。
- sub-agent 跨调用复用实例池(Claude Code 也是每次新建,先对齐)。
- LLM 自动发现可用 type:目前靠 task 工具 description 里枚举类型,LLM 自行选择。
- skill / RAG plugin 在 sub-agent 中的自动继承策略——交给 SubAgentDefinition.plugins 显式控制。
