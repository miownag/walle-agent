# 15 — Self-Evolution

## 设计哲学

自进化是 Walle Agent 的核心差异化能力。核心原则：

```
observe → reflect → propose → evaluate → approve → apply
```

**不是魔法，是工程管线。**

- 所有进化动作可观测、可回滚、可审批
- 在线进化（Online）已在 Phase 2 实现（`@walle-agent/evolution`）
- 离线进化（Offline）在后续版本中实现

---

## Package 与 Plugin 组织

Evolution 是独立插件包 `@walle-agent/evolution`，**依赖 `@walle-agent/memory`（必须先装），可选依赖 `@walle-agent/skills`**。后者缺席时 `taskReview` 会自动跳过 —— skill 提取没有可写的目的地。

```ts
import { Agent } from "@walle-agent/core";
import { OpenAIProvider } from "@walle-agent/openai";
import { MemoryPlugin } from "@walle-agent/memory";
import { SkillsPlugin } from "@walle-agent/skills";
import { EvolutionPlugin } from "@walle-agent/evolution";

const agent = await Agent.create({
  name: "Self-Evolving-Walle",
  model: new OpenAIProvider({ model: "gpt-4.1" }),
  plugins: [
    new MemoryPlugin({ rootDir: "./.walle" }),
    new SkillsPlugin({ project: "./.agents", user: "~/.agents" }),
    new EvolutionPlugin({
      explicitRemember: { enabled: true },
      periodicReview: { enabled: true, everyTurns: 10 },
      taskReview: { enabled: true, minToolCalls: 5 },
      memoryCreation: { enabled: true, requireApproval: false, minImportance: 0.5 },
      skillCreation: { enabled: true, requireApproval: true, minConfidence: 0.7 },
    }),
  ],
});
```

插件之间通过 `AgentContext` 上的约定字段 (`__memoryManager`, `__skillRegistry`) 互相查找 —— 核心包仍然保持无感知。

---

## Evolution Plugin 配置

```ts
export interface EvolutionPluginConfig {
  /** 进化状态根目录，默认 ./.walle/evolution */
  rootDir?: string;
  /** 审批队列目录，默认 <rootDir>/proposals */
  proposalStorePath?: string;

  /** 覆盖 review 使用的模型，默认复用 agent 的 model */
  reviewModel?: LLMProvider;

  /** 显式记忆：检测到"记住"等关键词时触发 */
  explicitRemember?: {
    enabled?: boolean;        // default true
    patterns?: RegExp[];
  };

  /** 周期性复盘：每 N 轮对话自动 review */
  periodicReview?: {
    enabled?: boolean;        // default false
    everyTurns?: number;      // default 10
    maxMessagesInReview?: number; // default 20
  };

  /** 任务复盘：复杂任务完成后自动提取 skill */
  taskReview?: {
    enabled?: boolean;        // default false
    minToolCalls?: number;    // default 5
    maxMessagesInReview?: number; // default 30
  };

  /** 记忆创建策略 */
  memoryCreation?: {
    enabled?: boolean;        // default true
    requireApproval?: boolean;// default false
    minImportance?: number;   // default 0.5
    minConfidence?: number;   // default 0.5
  };

  /** Skill 创建策略 */
  skillCreation?: {
    enabled?: boolean;        // default true
    requireApproval?: boolean;// default true
    minConfidence?: number;   // default 0.7
  };

  /** 审批回调。返回 true 即接受并立即 apply，返回 false 则丢弃。 */
  approvalHandler?: (proposal: EvolutionProposal) => Promise<boolean> | boolean;

  /** 提案生成时的观察回调（仅观察，不影响决策） */
  onProposal?: (proposal: EvolutionProposal) => Promise<void> | void;
}

export class EvolutionPlugin implements WallePlugin {
  name = "evolution";
  /** 暴露的审批队列，便于外部 CLI / UI 读取 */
  readonly proposalStore: ProposalStore;

  constructor(config?: EvolutionPluginConfig);

  /** 列出待审批 proposal */
  pending(): Promise<EvolutionProposal[]>;

  /** 审批并立即应用 */
  approveAndApply(id: string, note?: string): Promise<EvolutionProposal | undefined>;

  /** 拒绝（保留在文件系统作为审计） */
  reject(id: string, note?: string): Promise<EvolutionProposal | undefined>;

  /** 手动触发一次 evolution（测试/CLI 用） */
  runEvolution(runId: string, sessionId: string | undefined, messages: ModelMessage[]): Promise<void>;
}
```

> **后台执行**：evolution 在 `onRunEnd` 钩子中 **fire-and-forget** 派发，不阻塞用户响应。任何异常都被吞掉并打印到 stderr，不会让 agent run 失败。

---

## EvolutionEngine

核心引擎负责：

1. **触发判定** — 根据 `EvolutionContext`（runId / sessionId / turnCounter / messages）与插件配置，决定是否触发 `explicit_remember` / `periodic_review` / `task_review`。
2. **LLM 抽取** — 针对每种触发，调用 `model.chat({ responseFormat: "json" })` 并把消息喂给 `MEMORY_EXTRACTION_PROMPT` 或 `SKILL_EXTRACTION_PROMPT`。
3. **阈值过滤** — 依据 `memoryCreation.minImportance` / `minConfidence` / `skillCreation.minConfidence` 做基础质量门槛。
4. **审批分流** — 如果 `requireApproval=true` 且未提供 `approvalHandler`，则写入 `ProposalFileStore`；否则同步 apply。
5. **应用** — 通过 `MemoryManager.remember` 与 `SkillRegistry.register` 完成落盘。

关键特性：

- **容错**：任何一个触发失败都会被捕获，不会把异常抛回 agent run。
- **后台执行**：`EvolutionPlugin` 通过 `onRunEnd` 钩子 **fire-and-forget** 调度引擎，用户响应不会被阻塞。
- **可测试**：`engine.afterRun(ctx)` 与 `plugin.runEvolution(...)` 是纯函数式入口，vitest 中可以不过 Agent 直接驱动。
- **JSON 容错**：Provider 返回的 `json` 响应允许被 ```json``` 围栏包裹 / 带解释文字；引擎会尽力解析，失败就按"无提案"处理。

源码：`packages/evolution/src/evolution-engine.ts`。下面的 Prompts 和 Proposal 数据结构是公开 API。

---

## Prompts

```ts
const MEMORY_EXTRACTION_PROMPT = `
You are a memory reviewer for an AI agent.
Extract durable, useful memories from the conversation.

Return JSON:
{
  "memories": [
    {
      "type": "fact|preference|profile|decision|warning|procedure|summary",
      "content": "concise memory statement",
      "importance": 0.0-1.0,
      "confidence": 0.0-1.0,
      "scope": "mid|long",
      "tags": ["tag1", "tag2"]
    }
  ]
}

Rules:
- Do NOT store trivial or temporary information
- Do NOT store sensitive data (passwords, tokens, etc.)
- Prefer concise, actionable memories
- "long" scope: stable facts, preferences, project-level knowledge
- "mid" scope: session-specific conclusions, temporary decisions
- If nothing worth remembering, return {"memories":[]}
`.trim();

const SKILL_EXTRACTION_PROMPT = `
You are a skill reviewer for an AI agent.
Extract reusable procedures from successful complex tasks.

Return JSON:
{
  "skill": {
    "name": "short_name",
    "description": "What this skill helps with",
    "content": "Step-by-step reusable procedure...",
    "tags": ["tag1", "tag2"],
    "confidence": 0.0-1.0,
    "triggerExamples": ["example query 1", "example query 2"]
  }
}

A skill should be:
- Reusable across future similar tasks
- Procedural (steps), not just factual
- Concise but actionable
- Include when to use and when NOT to use

Return {"skill": null} if no reusable skill exists.
`.trim();
```

---

## Evolution Proposal Types

```ts
export type EvolutionReason =
  | "explicit_remember"
  | "periodic_review"
  | "task_review";

export interface EvolutionProposal {
  id?: string;
  type: "memory" | "skill";
  payload: MemoryProposal | SkillProposal;
  reason: EvolutionReason;
  runId?: string;
  sessionId?: string;
  createdAt?: string;
  /** `pending` (enqueued) → `approved` | `rejected` → `applied`. */
  status?: "pending" | "approved" | "rejected" | "applied";
  /** Free-form reviewer note on approve/reject. */
  note?: string;
}

export interface MemoryProposal {
  type: MemoryType;
  content: string;
  importance: number;
  confidence: number;
  scope: "mid" | "long";
  tags?: string[];
}

export interface SkillProposal {
  name: string;
  description: string;
  content: string;
  tags?: string[];
  confidence: number;
  triggerExamples?: string[];
  triggerKeywords?: string[];
}
```

---

## ProposalStore（审批队列）

```ts
export interface ProposalStore {
  /** Persist a new proposal (fills id/createdAt/status=pending if missing). */
  enqueue(proposal: EvolutionProposal): Promise<EvolutionProposal>;
  list(filter?: { status?: EvolutionProposal["status"] }): Promise<EvolutionProposal[]>;
  get(id: string): Promise<EvolutionProposal | undefined>;
  approve(id: string, note?: string): Promise<EvolutionProposal | undefined>;
  reject(id: string, note?: string): Promise<EvolutionProposal | undefined>;
  markApplied(id: string): Promise<void>;
  delete(id: string): Promise<void>;
}
```

默认实现 `ProposalFileStore`：

- 每个 proposal 是目录下一个 `<id>.json` 文件，直接可读可编辑 —— 人工审计、diff、版本控制都很友好。
- 状态切换（approve / reject / markApplied）是"rewrite 同一个文件"。
- 没有索引文件：`list()` 扫目录，对于 Phase 2 级别的量可以接受。

**审批的三种路径**：

1. **自动 apply（`requireApproval=false`）**：`enqueue` 后立刻 `applyProposal` 再 `markApplied`，同一个文件从 pending → applied，保留审计。
2. **同步审批（提供 `approvalHandler`）**：回调返回 `true` 即直接 apply，完全不写队列文件。
3. **离线审批（未提供 handler）**：proposal 写入 pending 队列，外部 CLI / UI 调用 `evolutionPlugin.approveAndApply(id)` 完成最后一步。

---

## 进化流程图

```
                    ┌─────────────────────────┐
                    │      Agent Run          │
                    └──────────┬──────────────┘
                               │
                    ┌──────────▼──────────────┐
                    │  Evolution Triggers      │
                    │  - Explicit "记住"       │
                    │  - Every N turns         │
                    │  - Complex task done     │
                    └──────────┬──────────────┘
                               │
                    ┌──────────▼──────────────┐
                    │  LLM Review & Extract    │
                    │  - Memory proposals      │
                    │  - Skill proposals       │
                    └──────────┬──────────────┘
                               │
              ┌────────────────┼────────────────┐
              │ requireApproval?                 │
              ▼ NO                              ▼ YES
    ┌────────────────┐              ┌─────────────────────┐
    │ Apply directly │              │ Enqueue to          │
    │ - memory.put() │              │ ProposalStore       │
    │ - skills.add() │              │                     │
    └────────────────┘              └──────────┬──────────┘
                                               │
                                    ┌──────────▼──────────┐
                                    │ External Review     │
                                    │ - CLI tool          │
                                    │ - Web UI            │
                                    │ - API endpoint      │
                                    └──────────┬──────────┘
                                               │
                                   ┌───────────┼───────────┐
                                   ▼                       ▼
                          ┌──────────────┐       ┌──────────────┐
                          │   Approved   │       │   Rejected   │
                          │   → Apply    │       │   → Discard  │
                          └──────────────┘       └──────────────┘
```

---

## 使用示例

```ts
import { Agent } from "@walle-agent/core";
import { OpenAIProvider } from "@walle-agent/openai";
import { MemoryPlugin } from "@walle-agent/memory";
import { SkillsPlugin } from "@walle-agent/skills";
import { EvolutionPlugin } from "@walle-agent/evolution";

const evolutionPlugin = new EvolutionPlugin({
  explicitRemember: { enabled: true },
  periodicReview: { enabled: true, everyTurns: 10 },
  taskReview: { enabled: true, minToolCalls: 5 },
  memoryCreation: { enabled: true, requireApproval: false, minImportance: 0.5 },
  skillCreation: { enabled: true, requireApproval: true, minConfidence: 0.7 },
  onProposal: async (p) => console.log(`proposal: ${p.type} / ${p.reason}`),
});

const agent = await Agent.create({
  name: "Self-Evolving-Walle",
  model: new OpenAIProvider({ model: "gpt-4.1" }),
  plugins: [
    // 顺序很重要：Memory 必须先装，Skills 可选。
    new MemoryPlugin({ rootDir: "./.walle" }),
    new SkillsPlugin({ project: "./.agents", user: "~/.agents" }),
    evolutionPlugin,
  ],
});

// 用户说"记住"→ 自动沉淀到长期记忆（memoryCreation.requireApproval=false）
await agent.run("记住：我所有项目默认用 pnpm，不要用 npm");

// 每 10 轮自动 review，提取有价值的记忆
for (let i = 0; i < 15; i++) {
  await agent.run(`第 ${i} 个问题...`);
}

// 复杂任务后自动提取 skill（requireApproval=true → 写入 pending 队列）
const pending = await evolutionPlugin.pending();
for (const p of pending) {
  console.log(p.reason, p.payload);
  // 人工 / CLI / UI 审批后：
  await evolutionPlugin.approveAndApply(p.id!, "looks good");
}
```

---

## Offline Evolution（Phase 2+）

离线进化在 MVP 之后实现，流程：

```
1. 收集 trace（TraceStore）
2. 生成评估数据集
3. 生成候选 prompt / skill / tool description 变体
4. 在 eval set 上跑分
5. 选择 Pareto 最优变体
6. 生成 diff / PR
7. 跑测试
8. 提交人工审批
9. 审批通过后应用

Score = α·SuccessRate + β·Quality - γ·Cost - δ·Latency
```
