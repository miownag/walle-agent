# 17 — Token Budget

## 问题

Agent 运行时需要向 prompt 注入多种上下文：
- System prompt
- 检索到的 Memory
- 检索到的 Skills
- RAG 知识文档
- 工具描述
- 对话历史

如果不做管控，总 token 数会轻易超过模型的 context window。

---

## 设计目标

1. 各模块通过 `ContextItem` 竞争有限的 token 预算
2. 按优先级裁剪：重要的上下文保留，次要的裁掉
3. 支持配置各模块的 token 配额
4. 内置到 core 中（不是插件）

---

## TokenBudgetConfig

```ts
export interface TokenBudgetConfig {
  /** 模型的总 context window 大小 */
  maxContextTokens: number;

  /** 预留给模型输出的 token 数 */
  reservedForOutput?: number;

  /** 各来源的配额分配 */
  allocation?: {
    /** 系统提示词 */
    system?: number;
    /** 对话历史 */
    history?: number;
    /** 记忆 */
    memory?: number;
    /** Skills */
    skills?: number;
    /** RAG */
    rag?: number;
    /** 工具描述 */
    tools?: number;
  };

  /** 溢出策略 */
  overflowStrategy?: "truncate" | "prioritize" | "summarize";
}
```

---

## TokenBudget Manager

```ts
export interface BudgetAllocation {
  items: ContextItem[];
  totalTokens: number;
  droppedItems: ContextItem[];
}

export class TokenBudget {
  private config: Required<TokenBudgetConfig>;

  constructor(config?: TokenBudgetConfig) {
    this.config = {
      maxContextTokens: config?.maxContextTokens ?? 128_000,
      reservedForOutput: config?.reservedForOutput ?? 4_096,
      allocation: {
        system: config?.allocation?.system ?? 2_000,
        history: config?.allocation?.history ?? 30_000,
        memory: config?.allocation?.memory ?? 4_000,
        skills: config?.allocation?.skills ?? 4_000,
        rag: config?.allocation?.rag ?? 8_000,
        tools: config?.allocation?.tools ?? 6_000,
      },
      overflowStrategy: config?.overflowStrategy ?? "prioritize",
    };
  }

  /**
   * 分配 token 预算，按优先级裁剪上下文项。
   */
  allocate(items: ContextItem[]): BudgetAllocation {
    const available = this.config.maxContextTokens - this.config.reservedForOutput;

    // 按来源分组
    const grouped = this.groupBySource(items);

    // 每个来源内按 priority 排序
    for (const group of grouped.values()) {
      group.sort((a, b) => b.priority - a.priority);
    }

    const selected: ContextItem[] = [];
    const dropped: ContextItem[] = [];
    let usedTokens = 0;

    // 策略：各来源按配额分配，超出配额的按 priority 全局竞争剩余空间
    const sourceOrder: Array<keyof typeof this.config.allocation> = [
      "system", "tools", "memory", "skills", "rag", "history",
    ];

    // Phase 1: 各来源在配额内选择
    const overflow: ContextItem[] = [];

    for (const source of sourceOrder) {
      const quota = this.config.allocation[source] ?? 0;
      const sourceItems = grouped.get(source) ?? [];
      let sourceUsed = 0;

      for (const item of sourceItems) {
        const tokens = item.estimatedTokens ?? this.estimateTokens(item.content);

        if (sourceUsed + tokens <= quota) {
          selected.push(item);
          sourceUsed += tokens;
          usedTokens += tokens;
        } else {
          overflow.push(item);
        }
      }
    }

    // Phase 2: 剩余空间分配给溢出项（按 priority 全局排序）
    const remaining = available - usedTokens;
    overflow.sort((a, b) => b.priority - a.priority);

    let overflowUsed = 0;
    for (const item of overflow) {
      const tokens = item.estimatedTokens ?? this.estimateTokens(item.content);

      if (overflowUsed + tokens <= remaining) {
        selected.push(item);
        overflowUsed += tokens;
      } else {
        dropped.push(item);
      }
    }

    return {
      items: selected,
      totalTokens: usedTokens + overflowUsed,
      droppedItems: dropped,
    };
  }

  /**
   * 简单 token 估算（英文按 4 chars/token，中文按 2 chars/token）。
   */
  private estimateTokens(content: string): number {
    // 粗略估算：中文字符多的文本用 1.5 chars/token
    const chineseChars = (content.match(/[一-鿿]/g) ?? []).length;
    const otherChars = content.length - chineseChars;
    return Math.ceil(chineseChars / 1.5 + otherChars / 4);
  }

  private groupBySource(items: ContextItem[]): Map<string, ContextItem[]> {
    const map = new Map<string, ContextItem[]>();
    for (const item of items) {
      const source = item.source;
      if (!map.has(source)) map.set(source, []);
      map.get(source)!.push(item);
    }
    return map;
  }
}
```

---

## 与 PromptBuilder 的集成

```ts
export class PromptBuilder {
  build(input: {
    systemPrompt?: string;
    input: AgentInput;
    context: ContextItem[];
    tools: Tool[];
  }): ModelMessage[] {
    const messages: ModelMessage[] = [];

    // 1. System prompt + 上下文拼装
    const systemParts: string[] = [];

    if (input.systemPrompt) {
      systemParts.push(input.systemPrompt);
    }

    // 按来源分组渲染
    const bySource = new Map<string, ContextItem[]>();
    for (const item of input.context) {
      if (!bySource.has(item.source)) bySource.set(item.source, []);
      bySource.get(item.source)!.push(item);
    }

    // Memory
    const memoryItems = bySource.get("memory") ?? [];
    if (memoryItems.length) {
      systemParts.push("## Relevant Memory\n" + memoryItems.map(i => `- ${i.content}`).join("\n"));
    }

    // Skills
    const skillItems = bySource.get("skills") ?? [];
    if (skillItems.length) {
      systemParts.push("## Relevant Skills\n" + skillItems.map(i => i.content).join("\n\n"));
    }

    // RAG
    const ragItems = bySource.get("rag") ?? [];
    if (ragItems.length) {
      systemParts.push("## Retrieved Knowledge\n" + ragItems.map(i => i.content).join("\n\n"));
    }

    messages.push({
      role: "system",
      content: systemParts.join("\n\n---\n\n"),
    });

    // 2. User message
    messages.push({
      role: "user",
      content: input.input.content,
    });

    return messages;
  }
}
```

---

## 使用示例

```ts
const agent = await Agent.create({
  name: "Budget-Aware-Agent",
  model: new OpenAIProvider({ model: "gpt-4.1" }),
  tokenBudget: {
    maxContextTokens: 128_000,
    reservedForOutput: 4_096,
    allocation: {
      system: 2_000,
      history: 40_000,
      memory: 5_000,
      skills: 3_000,
      rag: 10_000,
      tools: 5_000,
    },
    overflowStrategy: "prioritize",
  },
  plugins: [
    new MemoryPlugin(),
    new SkillsPlugin(),
    new SimpleRAGPlugin({ docsPath: "./docs" }),
  ],
});
```

---

## Token 计数精确化（可选优化）

对于需要精确计数的场景，可以使用 `LLMProvider.countTokens()`：

```ts
// 如果 Provider 支持精确计数
if (provider.countTokens) {
  const exact = await provider.countTokens(messages);
  // 用于 budget 微调
}
```

大多数场景下，估算足够准确（误差 < 10%），避免额外 API 调用开销。

---

## 与上下文压缩的协作

`TokenBudget` 控制 `ContextItem[]`（memory / skills / RAG / tools 描述等）。
`messages` 数组本身的体量由 [21 — Context Compression](./21-context-compression.md) 管控：

- **Micro**（默认随 memory 启用）：每个 turn 顶部把更早 turn 的 tool result 改写为占位符。
- **Macro**（opt-in）：估算 `estimateTokens(messages) > maxContextTokens × threshold` 时，在 turn 之间把 head 区间总结为一条 user 消息。

两层共用 `core/src/token-estimate.ts` 里的 `estimateTokens()`。
