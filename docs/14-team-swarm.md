# 14 — Team & Swarm

## 概念区分

| | Team | Swarm |
|---|------|-------|
| 结构 | 固定角色、预定义流程 | 动态选择、自组织 |
| 协作模式 | Supervisor / Pipeline / Parallel / Debate | Policy 驱动的动态调度 |
| 适用场景 | 角色明确的任务分工 | 复杂探索、多方案博弈 |

---

## 实现备忘（与本规格的偏差）

`@walle-agent/team` 落地时与早期 spec 文本有四处差异，记录在此：

1. **不 ship `TeamPlugin`**：spec 里 `TeamPlugin` 只是 `install()` 空壳，注释里也写明
   "Team 功能主要通过 API 调用"。当前实现直接 `new AgentTeam(...)` / `new Swarm(...)`，
   不需要任何 `WallePlugin` 注册。本文 spec 中的 `TeamPlugin` 段已移除。

2. **`createSubAgentTool` 自动 slugify 工具名**：spec 里 `name: \`delegate_${agent.name}\``
   直接拼接，但 OpenAI / Anthropic 都把 function name 限制在 `^[a-zA-Z0-9_-]+$`。
   实现里把 `agent.name` 走 `slugifyToolName(...)`（小写 + 非字母数字 → `_` + 去边缘下划线 + 截 60 字符），
   并允许 `options.name` 显式覆盖。

3. **Supervisor 用 build-time 构建 coordinator**：spec 里 `runSupervisor` 通过
   `(this.config.coordinator as any).runtime.config.model` 反射拿到 LLMProvider，
   再 `Agent.create` 出新的 coordinator 注入 delegate tools——破坏私有边界。
   实现提供 `createSupervisorTeam({ members, coordinator: { model, ... } })`
   helper，**调用时**就把 delegate tools 注册到 coordinator 上；
   `AgentTeam.runSupervisor` 退化成单纯 `coordinator.run(task)`。
   也保留 `TeamConfig.coordinator: Agent` 入口给已经手工构建好 coordinator 的用户。

4. **Debate / Swarm 完整聚合 telemetry**：spec 里 debate 在没有 coordinator 时
   返回 `{ messages: [], toolCalls: [], events: [] }`，吞掉所有轮次的痕迹；
   Swarm 结果也丢掉了 `messages`。实现里这两处都通过 `flatMap` 把每次
   `agent.run` 的产物完整聚合进最终 `AgentResult`，跟 `runParallel` / `runPipeline` 对齐。

---

## SubAgent（子 Agent）

> SubAgent 在 Walle 里有两种形态,职责正交,可同时使用:
>
> | 形态 | 提供方 | 调度时机 | 工具数量 | 适合场景 |
> |---|---|---|---|---|
> | **静态包装(Static Wrapper)** | `@walle-agent/team` 的 `createSubAgentTool` | build-time | N 个 `delegate_<slug>` | 提前实例化好 N 个具体 Agent;Coordinator 知道每个的角色 |
> | **动态调度(Dynamic Task)** | `@walle-agent/core` 内置 `task` 工具 + `SubAgentRegistry` | run-time | **1 个**通用 `task` | 用户预先注册「类型」,LLM 用 `subagent_type` 选;每次跑完即销毁 |
>
> 下文先讲创建方式与静态包装,然后单独一节讲动态调度(`Task` 工具)。

### 创建方式

```ts
// 方式一：手动创建独立 Agent
const researcher = await Agent.create({
  name: "Researcher",
  model: provider,
  systemPrompt: "You are a research specialist...",
  tools: [webSearchTool],
});

// 方式二：从现有 Agent 派生
const subAgent = await Agent.create({
  name: "SubWorker",
  model: mainAgent.config.model, // 继承 model
  systemPrompt: "You are a sub-worker for specific task...",
});
```

### SubAgent Tool

把子 Agent 封装成 Tool，主 Agent 可以通过 function calling 委托任务。
注意工具名会自动 slugify（见上文实现备忘 #2）。

```ts
import { z } from "zod";
import { defineTool } from "@walle-agent/core";

export function createSubAgentTool(agent: Agent, options?: {
  name?: string;
  description?: string;
  maxTokens?: number;
}): Tool<{ task: string }, { result: string }> {
  return defineTool(
    options?.name ?? `delegate_${slugifyToolName(agent.name)}`,
    options?.description ?? `Delegate a task to ${agent.name}.`,
    {
      task: z.string().describe("Task description for the sub-agent"),
    },
    async ({ task }) => {
      const result = await agent.run(task);
      return { result: result.content };
    },
    {
      riskLevel: "low",
      tags: ["sub-agent"],
    },
  );
}
```

---

## AgentTeam

```ts
export interface TeamMember {
  name: string;
  agent: Agent;
  role: string;
  description?: string;
}

export interface TeamConfig {
  members: TeamMember[];
  coordinator?: Agent;
}

export interface TeamRunOptions {
  strategy: "supervisor" | "pipeline" | "parallel" | "debate";
  maxRounds?: number;
  /** Pipeline 模式下的成员执行顺序（默认按 members 数组顺序） */
  pipelineOrder?: string[];
}

export class AgentTeam {
  constructor(private readonly config: TeamConfig) {}

  async run(task: string, options: TeamRunOptions): Promise<AgentResult> {
    switch (options.strategy) {
      case "parallel":
        return this.runParallel(task);
      case "pipeline":
        return this.runPipeline(task, options);
      case "debate":
        return this.runDebate(task, options);
      case "supervisor":
      default:
        return this.runSupervisor(task, options);
    }
  }

  /**
   * 并行策略：所有成员同时执行，汇总结果。
   */
  private async runParallel(task: string): Promise<AgentResult> {
    const results = await Promise.all(
      this.config.members.map(member =>
        member.agent.run(`[Your Role: ${member.role}]\n\nTask: ${task}`),
      ),
    );

    const content = results
      .map((r, i) => `## ${this.config.members[i].name} (${this.config.members[i].role})\n\n${r.content}`)
      .join("\n\n---\n\n");

    return {
      content,
      messages: results.flatMap(r => r.messages),
      toolCalls: results.flatMap(r => r.toolCalls),
      events: results.flatMap(r => r.events),
    };
  }

  /**
   * 流水线策略：按序执行，前一个的输出是后一个的输入。
   */
  private async runPipeline(task: string, options: TeamRunOptions): Promise<AgentResult> {
    const order = options.pipelineOrder ?? this.config.members.map(m => m.name);
    const ordered = order.map(name => this.config.members.find(m => m.name === name)!);

    let currentInput = task;
    const allResults: AgentResult[] = [];

    for (const member of ordered) {
      const prompt = [
        `[Your Role: ${member.role}]`,
        ``,
        `Previous stage output:`,
        currentInput,
        ``,
        `Your task: Process the above and produce your output.`,
      ].join("\n");

      const result = await member.agent.run(prompt);
      allResults.push(result);
      currentInput = result.content;
    }

    return {
      content: currentInput,
      messages: allResults.flatMap(r => r.messages),
      toolCalls: allResults.flatMap(r => r.toolCalls),
      events: allResults.flatMap(r => r.events),
    };
  }

  /**
   * 辩论策略：多轮互评。
   */
  private async runDebate(task: string, options: TeamRunOptions): Promise<AgentResult> {
    const maxRounds = options.maxRounds ?? 3;
    let context = `Task: ${task}\n\n`;

    for (let round = 0; round < maxRounds; round++) {
      const roundResults = await Promise.all(
        this.config.members.map(member =>
          member.agent.run([
            `[Your Role: ${member.role}]`,
            `[Round ${round + 1}/${maxRounds}]`,
            ``,
            context,
            ``,
            `Provide your analysis. If this is not the first round, respond to other members' points.`,
          ].join("\n")),
        ),
      );

      context += `\n## Round ${round + 1}\n\n`;
      for (let i = 0; i < roundResults.length; i++) {
        context += `### ${this.config.members[i].name}: ${roundResults[i].content}\n\n`;
      }
    }

    // 最终由 coordinator 总结（如果有）
    if (this.config.coordinator) {
      const summary = await this.config.coordinator.run(
        `Summarize the debate and provide a final decision:\n\n${context}`,
      );
      return summary;
    }

    return { content: context, messages: [], toolCalls: [], events: [] };
  }

  /**
   * Supervisor 策略：coordinator 动态分配任务。
   *
   * 当前实现：要求 `config.coordinator` 已经带好 delegate tools；
   * 直接 `coordinator.run(task)` 即可。
   * 推荐使用 `createSupervisorTeam(...)` helper 构建（见下文）。
   */
  private async runSupervisor(task: string): Promise<AgentResult> {
    if (!this.config.coordinator) {
      throw new Error(
        "Supervisor strategy requires a coordinator agent in TeamConfig. " +
          "Use createSupervisorTeam() to build one with delegate tools wired in.",
      );
    }
    return this.config.coordinator.run(task);
  }
}
```

---

## createSupervisorTeam helper

build-time 构建带 delegate tools 的 coordinator，把 spec 里反射拿 model 的写法
换成显式注入：

```ts
export interface SupervisorTeamOptions {
  members: TeamMember[];
  coordinator: {
    name?: string;
    model: LLMProvider;
    systemPrompt?: string;
    plugins?: WallePlugin[];
  };
}

export async function createSupervisorTeam(opts: SupervisorTeamOptions): Promise<AgentTeam> {
  const delegateTools = opts.members.map(m =>
    createSubAgentTool(m.agent, {
      description: `Delegate a sub-task to ${m.name} (${m.role})${m.description ? ` — ${m.description}` : ""}.`,
    }),
  );

  const coordinator = await Agent.create({
    name: opts.coordinator.name ?? "Supervisor",
    model: opts.coordinator.model,
    systemPrompt: opts.coordinator.systemPrompt ?? defaultSupervisorPrompt(opts.members),
    tools: delegateTools,
    plugins: opts.coordinator.plugins,
  });

  return new AgentTeam({ members: opts.members, coordinator });
}
```

---

## Swarm

动态协作：基于 Policy 选择 Agent、基于 Blackboard 共享状态。

```ts
export interface SwarmPolicy {
  /** 选择本轮需要参与的 agent */
  selectAgents(task: string, state: SwarmState, members: TeamMember[]): Promise<TeamMember[]>;

  /** 判断是否继续 */
  shouldContinue(state: SwarmState): Promise<boolean>;

  /** 可选：生成最终结果 */
  synthesize?(state: SwarmState): Promise<string>;
}

export interface SwarmState {
  task: string;
  rounds: SwarmRound[];
  blackboard: Blackboard;
}

export interface SwarmRound {
  index: number;
  agents: string[];
  outputs: AgentResult[];
}

export class Swarm {
  constructor(
    private readonly members: TeamMember[],
    private readonly policy: SwarmPolicy,
    private readonly blackboard = new Blackboard(),
  ) {}

  async run(task: string): Promise<AgentResult> {
    const state: SwarmState = {
      task,
      rounds: [],
      blackboard: this.blackboard,
    };

    while (await this.policy.shouldContinue(state)) {
      const selected = await this.policy.selectAgents(task, state, this.members);

      const prompt = this.blackboard.renderForAgent(task);

      const outputs = await Promise.all(
        selected.map(member => member.agent.run(prompt)),
      );

      const round: SwarmRound = {
        index: state.rounds.length,
        agents: selected.map(s => s.name),
        outputs,
      };

      state.rounds.push(round);

      // 写入黑板
      for (let i = 0; i < outputs.length; i++) {
        await this.blackboard.post({
          agent: selected[i].name,
          content: outputs[i].content,
          round: round.index,
        });
      }
    }

    // 生成最终结果
    const finalContent = this.policy.synthesize
      ? await this.policy.synthesize(state)
      : this.blackboard.renderFinal();

    return {
      content: finalContent,
      messages: [],
      toolCalls: state.rounds.flatMap(r => r.outputs.flatMap(o => o.toolCalls)),
      events: state.rounds.flatMap(r => r.outputs.flatMap(o => o.events)),
    };
  }
}
```

---

## Blackboard（共享状态板）

```ts
export interface BlackboardEntry {
  agent: string;
  content: string;
  round: number;
  timestamp: string;
}

export class Blackboard {
  private entries: BlackboardEntry[] = [];

  async post(entry: Omit<BlackboardEntry, "timestamp">): Promise<void> {
    this.entries.push({
      ...entry,
      timestamp: new Date().toISOString(),
    });
  }

  getEntries(): BlackboardEntry[] {
    return [...this.entries];
  }

  renderForAgent(task: string): string {
    if (!this.entries.length) return task;

    const history = this.entries
      .map(e => `[${e.agent} @ Round ${e.round}]: ${e.content}`)
      .join("\n\n");

    return `Task: ${task}\n\n## Previous Discussion:\n\n${history}\n\n## Your Turn:`;
  }

  renderFinal(): string {
    return this.entries.map(e => `## ${e.agent}\n${e.content}`).join("\n\n---\n\n");
  }
}
```

---

## Coordinator Interface

```ts
export interface Coordinator {
  coordinate(params: CoordinateParams): Promise<AgentResult>;
}

export interface CoordinateParams {
  task: string;
  members: TeamMember[];
  maxRounds: number;
  blackboard?: Blackboard;
}
```

---

## 使用示例

```ts
import { Agent } from "@walle-agent/core";
import { AgentTeam, createSupervisorTeam, createSubAgentTool } from "@walle-agent/team";

// 创建团队成员
const researcher = await Agent.create({ name: "Researcher", model: provider, systemPrompt: "..." });
const coder = await Agent.create({ name: "Coder", model: provider, systemPrompt: "..." });
const reviewer = await Agent.create({ name: "Reviewer", model: provider, systemPrompt: "..." });

// Pipeline 模式
const team = new AgentTeam({
  members: [
    { name: "Researcher", agent: researcher, role: "Research the problem" },
    { name: "Coder", agent: coder, role: "Implement the solution" },
    { name: "Reviewer", agent: reviewer, role: "Review the implementation" },
  ],
});

const result = await team.run("实现一个 LRU Cache", { strategy: "pipeline" });

// Supervisor 模式（用 helper 构建带 delegate tools 的 coordinator）
const supervised = await createSupervisorTeam({
  members: [
    { name: "Researcher", agent: researcher, role: "Research" },
    { name: "Coder", agent: coder, role: "Implement" },
  ],
  coordinator: { model: provider },
});

const supResult = await supervised.run("解决 X", { strategy: "supervisor" });
```

---

## Dynamic SubAgent（`task` 工具）

对齐 Claude Code 的 `Task` 工具语义:**主 Agent 通过一个内置的 `task` 工具
动态派发任务给某个"sub-agent 类型"**;每次调用临时实例化一个 sub-agent,
跑完即销毁,主 Agent 只看到最终总结。

详细的 built-in 工具说明见 [`20-builtin-tools.md`](./20-builtin-tools.md#task)。
本节聚焦 SubAgent 类型注册 + Registry/Plugin 入口。

### SubAgentDefinition

```ts
export interface SubAgentDefinition {
  /** 唯一 type 名,作为 task 工具的 subagent_type 入参 */
  type: string;
  /** 给主 Agent LLM 的描述,影响什么时候选这个 sub-agent */
  description?: string;
  systemPrompt?: string;
  /** 默认继承父 Agent 的 model;显式给 def.model 可覆盖(例如换 cheaper model) */
  model?: LLMProvider;
  /** sub-agent 的 native tools(默认 []) */
  tools?: Tool[];
  /** 默认 false——不自动给 sub-agent built-in 工具(防 task 递归) */
  useBuiltinTools?: boolean | BuiltinToolsConfig;
  /** sub-agent 的 plugins(memory/skills/rag…均独立) */
  plugins?: WallePlugin[];
  /** 默认继承父 Agent 的 maxTurns */
  maxTurns?: number;
  /** 默认 false:只回 { result };true 则附带 messages + toolCalls */
  verbose?: boolean;
  /** 默认 false:sub-agent 用独立 sessionId,不污染父会话 memory */
  inheritSession?: boolean;
}
```

### SubAgentRegistry

`@walle-agent/core` 暴露 `SubAgentRegistry` 类——纯 TS、无运行时依赖。每个
`Agent` 实例内部各自持有一份 registry。

```ts
export class SubAgentRegistry {
  register(def: SubAgentDefinition): void;     // 重复 type → throw
  get(type: string): SubAgentDefinition | undefined;
  has(type: string): boolean;
  list(): SubAgentDefinition[];
  types(): string[];
}
```

### 三种入口

#### 1) 糖语法:`AgentConfig.subAgents`

最简方式,推荐默认用法:

```ts
const agent = await Agent.create({
  name: "Walle",
  model: openai,
  subAgents: [
    {
      type: "researcher",
      description: "Web research and summarization",
      systemPrompt: "You are a research specialist…",
      tools: [webSearchTool],
    },
    { type: "code-reviewer", systemPrompt: "Review code for bugs and style…" },
  ],
});
```

LLM 看到一个 `task` 工具,可这样调用:

```jsonc
{
  "subagent_type": "researcher",
  "description": "find LRU eviction tradeoffs",
  "prompt": "比较 LRU vs LFU vs ARC 的命中率特征,给出 200 字结论"
}
```

#### 2) Plugin 形态:`SubAgentsPlugin`(由 `@walle-agent/team` 提供)

适合喜欢用 plugin 数组管理装配的用户:

```ts
import { SubAgentsPlugin } from "@walle-agent/team";

const agent = await Agent.create({
  name: "Walle",
  model: openai,
  plugins: [
    new SubAgentsPlugin({
      types: [
        { type: "researcher", systemPrompt: "…", tools: [webSearchTool] },
        { type: "coder", systemPrompt: "…" },
      ],
    }),
  ],
});
```

> **互斥**:同一 Agent 不能同时使用 `config.subAgents` 字段 + `SubAgentsPlugin`。
> Plugin 在 install 时检测到冲突会抛错——避免重复注册同 type 的难调 bug。

#### 3) 高级:`createTaskTool` factory

完全接管装配流程,自己拿 registry 实例:

```ts
import { Agent, SubAgentRegistry, createTaskTool } from "@walle-agent/core";

const registry = new SubAgentRegistry();
registry.register({ type: "researcher", systemPrompt: "…" });

const agent = await Agent.create({
  model: openai,
  tools: [createTaskTool({ registry, defaultModel: openai })],
  useBuiltinTools: { excludeTools: ["task"] }, // 关掉默认那个
});
```

### Sub-agent 生命周期

每次 `task` 调用:

1. `registry.get(subagent_type)` → `def`(unknown 时返回 `{error, available}`,**不抛**)
2. `Agent.create({ ...def, model: def.model ?? defaultModel ?? parent.model })`
3. `agent.run(prompt, { signal: parentSignal })`(父 abort → child 跟着停)
4. `agent.dispose()`(`finally` 块,确保 plugin 资源释放)

### 防递归默认

Sub-agent 的 `useBuiltinTools` 默认 **`false`**——sub-agent 默认拿不到 `task`
工具,无法再开 sub-sub-agent。需要嵌套时显式打开:

```ts
{
  type: "research-coordinator",
  systemPrompt: "…",
  useBuiltinTools: { includeTools: ["task"] },
  plugins: [new SubAgentsPlugin({ types: [/* sub-sub types */] })],
}
```

### 与静态 `createSubAgentTool` 的区别

| | 静态包装 | 动态 task |
|---|---|---|
| 实例化 | build-time(`Agent.create` 一次,长寿命) | run-time(每次调用都 create+dispose) |
| 工具数 | N 个 `delegate_<slug>` | 1 个 `task` |
| 主 Agent 看到的工具列表 | 每个 sub-agent 一行 | 一行,但 description 里枚举 types |
| 资源占用 | sub-agent 常驻内存(包含其 plugins) | 每次跑临时 Agent,跑完释放 |
| 适合场景 | 已有具体 Agent 实例,角色固定 | 类型化任务派发,实例数量随对话变化 |

两套机制可并存:你完全可以一个 Agent 同时挂载 `createSubAgentTool` 包出的
固定专家 + 通用 `task` 工具调度的临时 sub-agent。

