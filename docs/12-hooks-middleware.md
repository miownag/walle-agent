# 12 — Hooks & Middleware

## 概念区分

| | Hooks | Middleware |
|---|-------|-----------|
| 作用 | 旁路监听（side-effect） | 链式修改（transform） |
| 能否修改数据 | 不应修改（但技术上可以） | 核心职责就是修改 |
| 调用模式 | 广播（所有 listener 并行） | 管线（onion model，按序串行） |
| 典型场景 | 日志、审计、指标、Trace、自动记忆 | 鉴权、限流、输入过滤、输出过滤、上下文注入 |

---

## Hooks

### AgentHooks 类型定义

```ts
export interface AgentHooks {
  /** Agent 初始化完成 */
  onInit: (ctx: AgentContext) => Promise<void> | void;

  /** 一次 run 开始 */
  onRunStart: (payload: { input: AgentInput }) => Promise<void> | void;

  /** 一次 run 结束 */
  onRunEnd: (payload: { result: AgentResult }) => Promise<void> | void;

  /** 一次 run 出错 */
  onRunError: (payload: { error: unknown }) => Promise<void> | void;

  /** LLM 调用前 */
  beforeModelCall: (payload: { messages: ModelMessage[] }) => Promise<void> | void;

  /** LLM 调用后 */
  afterModelCall: (payload: { message: ModelMessage; usage?: TokenUsage }) => Promise<void> | void;

  /** 工具调用前 */
  beforeToolCall: (payload: { call: ModelToolCall }) => Promise<void> | void;

  /** 工具调用后 */
  afterToolCall: (payload: { record: ToolCallRecord }) => Promise<void> | void;

  /** 记忆写入前 */
  beforeMemoryWrite: (payload: { item: MemoryItem }) => Promise<void> | void;

  /** 记忆写入后 */
  afterMemoryWrite: (payload: { item: MemoryItem }) => Promise<void> | void;

  /** Skill 写入前 */
  beforeSkillWrite: (payload: { skill: Skill }) => Promise<void> | void;

  /** Skill 写入后 */
  afterSkillWrite: (payload: { skill: Skill }) => Promise<void> | void;
}
```

### HookManager

支持多个 listener 注册到同一个 hook：

```ts
export class HookManager {
  private hooks = new Map<string, Set<Function>>();

  register<K extends keyof AgentHooks>(name: K, handler: AgentHooks[K]): () => void {
    if (!this.hooks.has(name)) {
      this.hooks.set(name, new Set());
    }
    this.hooks.get(name)!.add(handler);

    // 返回取消注册函数
    return () => this.hooks.get(name)?.delete(handler);
  }

  registerAll(hooks: Partial<AgentHooks>): void {
    for (const [name, handler] of Object.entries(hooks)) {
      if (handler) {
        this.register(name as keyof AgentHooks, handler as any);
      }
    }
  }

  async emit<K extends keyof AgentHooks>(
    name: K,
    payload: Parameters<AgentHooks[K]>[0],
  ): Promise<void> {
    const handlers = this.hooks.get(name);
    if (!handlers?.size) return;

    // 并行执行所有 handlers（不等待某个完成才执行下一个）
    const results = await Promise.allSettled(
      [...handlers].map(handler => (handler as any)(payload)),
    );

    // 记录失败但不阻塞
    for (const result of results) {
      if (result.status === "rejected") {
        console.error(`[Hook ${name}] Error:`, result.reason);
      }
    }
  }
}
```

### Hook 使用示例

```ts
const agent = await Agent.create({
  name: "my-agent",
  model: provider,
  hooks: {
    onRunStart({ input }) {
      console.log(`[Run Start] Input: ${input.content}`);
    },

    afterToolCall({ record }) {
      console.log(`[Tool] ${record.name}: ${record.status} (${record.durationMs}ms)`);
    },

    onRunEnd({ result }) {
      console.log(`[Run End] Token usage: ${result.usage?.totalTokens}`);
    },
  },
});
```

---

## Middleware

### Middleware Interface

```ts
export interface Middleware {
  name: string;

  /** 处理输入（可修改、拒绝、增强） */
  beforeInput?(input: AgentInput, next: () => Promise<AgentInput>): Promise<AgentInput>;

  /** 处理消息列表（可注入、修改、裁剪） */
  beforeModel?(messages: ModelMessage[], next: () => Promise<ModelMessage[]>): Promise<ModelMessage[]>;

  /** 处理输出（可修改、过滤、增强） */
  afterOutput?(result: AgentResult, next: () => Promise<AgentResult>): Promise<AgentResult>;
}
```

### MiddlewarePipeline

洋葱模型：先注册的 middleware 先执行 beforeInput/beforeModel，后执行 afterOutput。

```ts
export class MiddlewarePipeline {
  private middlewares: Middleware[] = [];

  use(middleware: Middleware): void {
    this.middlewares.push(middleware);
  }

  async beforeInput(input: AgentInput): Promise<AgentInput> {
    return this.compose("beforeInput", input);
  }

  async beforeModel(messages: ModelMessage[]): Promise<ModelMessage[]> {
    return this.compose("beforeModel", messages);
  }

  async afterOutput(result: AgentResult): Promise<AgentResult> {
    // afterOutput 反向执行
    return this.composeReverse("afterOutput", result);
  }

  private async compose<T>(method: string, initial: T): Promise<T> {
    let index = -1;

    const dispatch = async (i: number, current: T): Promise<T> => {
      if (i <= index) throw new Error("next() called multiple times");
      index = i;

      const mw = this.middlewares[i];
      const handler = mw?.[method as keyof Middleware];

      if (!handler || i >= this.middlewares.length) return current;

      return (handler as Function)(current, () => dispatch(i + 1, current));
    };

    return dispatch(0, initial);
  }

  private async composeReverse<T>(method: string, initial: T): Promise<T> {
    let current = initial;

    for (let i = this.middlewares.length - 1; i >= 0; i--) {
      const mw = this.middlewares[i];
      const handler = mw?.[method as keyof Middleware];
      if (handler) {
        current = await (handler as Function)(current, async () => current);
      }
    }

    return current;
  }
}
```

---

### 内置 Middleware 示例

#### 输入过滤

```ts
export const inputSanitizerMiddleware: Middleware = {
  name: "input-sanitizer",

  async beforeInput(input, next) {
    // 移除潜在的 prompt injection 模式
    const sanitized = {
      ...input,
      content: typeof input.content === "string"
        ? input.content.replace(/\[SYSTEM\]/gi, "")
        : input.content,
    };
    return next(); // 传递给下一个 middleware
  },
};
```

#### 输出长度限制

```ts
export function maxOutputLength(maxChars: number): Middleware {
  return {
    name: "max-output-length",

    async afterOutput(result, next) {
      const processed = await next();
      if (processed.content.length > maxChars) {
        return {
          ...processed,
          content: processed.content.slice(0, maxChars) + "\n\n[Output truncated]",
        };
      }
      return processed;
    },
  };
}
```

#### 限流

```ts
export function rateLimiter(options: { maxCalls: number; windowMs: number }): Middleware {
  const calls: number[] = [];

  return {
    name: "rate-limiter",

    async beforeInput(input, next) {
      const now = Date.now();
      const windowStart = now - options.windowMs;

      // 清理过期记录
      while (calls.length && calls[0] < windowStart) calls.shift();

      if (calls.length >= options.maxCalls) {
        throw new Error("Rate limit exceeded");
      }

      calls.push(now);
      return next();
    },
  };
}
```

---

## 注册方式

### 方式一：AgentConfig 直接配置

```ts
const agent = await Agent.create({
  hooks: { ... },
  middleware: [rateLimiter({ maxCalls: 10, windowMs: 60_000 })],
});
```

### 方式二：插件中注册

```ts
class MyPlugin implements WallePlugin {
  name = "my-plugin";

  install(ctx: AgentContext) {
    ctx.registerHook("afterToolCall", ({ record }) => {
      metrics.recordToolCall(record);
    });

    ctx.registerMiddleware(rateLimiter({ maxCalls: 100, windowMs: 60_000 }));
  }
}
```
