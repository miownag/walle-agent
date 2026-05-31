# 03 — Core Runtime

## Agent 主类

```ts
export class Agent {
  readonly id: string;
  readonly name: string;

  private runtime: AgentRuntime;

  private constructor(config: ResolvedAgentConfig) {
    this.id = config.id ?? crypto.randomUUID();
    this.name = config.name;
    this.runtime = new AgentRuntime(config, this);
  }

  /**
   * 创建 Agent 实例。初始化所有插件。
   */
  static async create(config: AgentConfig): Promise<Agent> {
    const resolved = resolveConfig(config);
    const agent = new Agent(resolved);
    await agent.runtime.init();
    return agent;
  }

  /**
   * 非流式执行。
   */
  run(input: string | AgentInput): Promise<AgentResult>;

  /**
   * 流式执行。
   */
  run(input: string | AgentInput, options: { stream: true } & RunOptions): AgentStream;

  /**
   * 统一入口实现。
   */
  run(input: string | AgentInput, options?: RunOptions): Promise<AgentResult> | AgentStream {
    if (options?.stream) {
      return this.runtime.stream(input, options);
    }
    return this.runtime.run(input, options);
  }

  /**
   * 销毁 Agent，释放所有资源。
   */
  async dispose(): Promise<void> {
    await this.runtime.dispose();
  }
}
```

---

## AgentConfig

```ts
export interface AgentConfig {
  id?: string;
  name: string;
  description?: string;

  /** LLM Provider 实例 */
  model: LLMProvider;

  /** 系统提示词 */
  systemPrompt?: string;

  /** 原生工具 */
  tools?: Tool[];

  /** 插件列表（Memory、Skills、MCP、Evolution 等） */
  plugins?: WallePlugin[];

  /** Hooks 快捷配置（也可通过插件注册） */
  hooks?: Partial<AgentHooks>;

  /** Middleware 快捷配置（也可通过插件注册） */
  middleware?: Middleware[];

  /** Token 预算策略 */
  tokenBudget?: TokenBudgetConfig;

  /** 执行限制 */
  maxTurns?: number;
  maxToolCallsPerTurn?: number;

  /** 权限策略 */
  permissions?: PermissionPolicy;
}
```

---

## AgentInput / AgentResult

```ts
export interface AgentInput {
  content: string | ContentBlock[];
  userId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  attachments?: Attachment[];
}

export interface AgentResult {
  content: string;
  messages: ModelMessage[];
  toolCalls: ToolCallRecord[];
  events: AgentEvent[];
  usage?: TokenUsage;
  metadata?: Record<string, unknown>;
}
```

---

## AgentRuntime（执行引擎）

```ts
export class AgentRuntime {
  private toolRegistry: ToolRegistry;
  private hookManager: HookManager;
  private middlewarePipeline: MiddlewarePipeline;
  private pluginContext: AgentContextImpl;
  private eventBus: EventBus;
  private tokenBudget: TokenBudget;
  private promptBuilder: PromptBuilder;

  constructor(
    private readonly config: ResolvedAgentConfig,
    private readonly agent: Agent,
  ) {
    this.eventBus = new EventBus();
    this.toolRegistry = new ToolRegistry();
    this.hookManager = new HookManager();
    this.middlewarePipeline = new MiddlewarePipeline();
    this.tokenBudget = new TokenBudget(config.tokenBudget);
    this.promptBuilder = new PromptBuilder();

    this.pluginContext = new AgentContextImpl({
      agent: this.agent,
      config: this.config,
      events: this.eventBus,
      toolRegistry: this.toolRegistry,
      hookManager: this.hookManager,
      middlewarePipeline: this.middlewarePipeline,
    });
  }

  async init(): Promise<void> {
    // 1. 注册原生工具
    for (const tool of this.config.tools ?? []) {
      this.toolRegistry.register(tool);
    }

    // 2. 注册快捷 hooks
    if (this.config.hooks) {
      this.hookManager.registerAll(this.config.hooks);
    }

    // 3. 注册快捷 middleware
    for (const mw of this.config.middleware ?? []) {
      this.middlewarePipeline.use(mw);
    }

    // 4. 安装插件（顺序执行）
    for (const plugin of this.config.plugins ?? []) {
      await plugin.install(this.pluginContext);
    }

    await this.hookManager.emit("onInit", this.pluginContext);
  }

  /**
   * 非流式执行：内部调用 stream，collect 所有事件后返回完整结果。
   */
  async run(input: string | AgentInput, options?: RunOptions): Promise<AgentResult> {
    const stream = this.stream(input, options);
    return stream.collect();
  }

  /**
   * 流式执行：核心执行循环。
   * 返回 AgentStream（AsyncIterable<AgentStreamEvent>）。
   */
  stream(input: string | AgentInput, options?: RunOptions): AgentStream {
    const normalizedInput = normalizeInput(input);
    return new AgentStream(this.executeGenerator(normalizedInput, options));
  }

  /**
   * 核心执行生成器。
   */
  private async *executeGenerator(
    input: AgentInput,
    options?: RunOptions,
  ): AsyncGenerator<AgentStreamEvent> {
    // 1. Middleware: beforeInput
    const processedInput = await this.middlewarePipeline.beforeInput(input);

    const runId = crypto.randomUUID();
    const sessionId = processedInput.sessionId;

    // 2. Emit run_start（带 runId / sessionId，供 Memory 等插件关联）
    yield { type: "run_start", input: processedInput, runId, sessionId };
    await this.eventBus.emit("run_start", { input: processedInput, runId, sessionId });
    await this.hookManager.emit("onRunStart", { input: processedInput, runId, sessionId });

    // 3. 让插件（Memory）注入先前的 conversation history
    const history: ModelMessage[] = [];
    await this.eventBus.emit("collect_messages", { sessionId, into: history });

    // 4. 通过 EventBus 让插件注入上下文（Memory/Skills/RAG）
    const contextItems = await this.collectContext(processedInput);

    // 5. Token 预算分配
    const budget = this.tokenBudget.allocate(contextItems);

    // 6. 构建消息列表：system + <context> + history + 当前 user input
    const messages = this.promptBuilder.build({
      systemPrompt: this.config.systemPrompt,
      input: processedInput,
      context: budget.items,
      tools: this.toolRegistry.list(),
      conversationHistory: history,
    });

    // 6. 执行循环
    const maxTurns = this.config.maxTurns ?? 20;

    for (let turn = 0; turn < maxTurns; turn++) {
      await this.hookManager.emit("beforeModelCall", { messages });

      yield { type: "model_call_start", turn };

      // 流式调用 LLM
      const llmStream = this.config.model.stream({
        messages,
        tools: this.toolRegistry.toModelTools(),
      });

      let assistantMessage: ModelMessage | null = null;
      let toolCalls: ModelToolCall[] = [];

      for await (const chunk of llmStream) {
        yield { type: "llm_chunk", chunk };

        if (chunk.type === "text_delta") {
          yield { type: "text_delta", content: chunk.content };
        }

        if (chunk.type === "tool_call_delta") {
          yield { type: "tool_call_delta", ...chunk };
        }

        if (chunk.type === "message_complete") {
          assistantMessage = chunk.message;
          toolCalls = chunk.toolCalls ?? [];
        }
      }

      if (!assistantMessage) {
        throw new Error("LLM stream ended without complete message");
      }

      messages.push(assistantMessage);
      yield { type: "model_call_end", message: assistantMessage };
      await this.hookManager.emit("afterModelCall", { message: assistantMessage });

      // 没有工具调用，结束循环
      if (!toolCalls.length) {
        break;
      }

      // 执行工具调用
      for (const call of toolCalls) {
        yield { type: "tool_call_start", call };
        await this.hookManager.emit("beforeToolCall", { call });

        const record = await this.executeToolCall(call);

        yield { type: "tool_call_end", record };
        await this.hookManager.emit("afterToolCall", { record });

        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: serializeToolOutput(record.output),
        });
      }
    }

    // 7. Run end（带 status：completed / user-cancelled / error）
    yield {
      type: "run_end",
      runId,
      sessionId,
      status: signal?.aborted ? "user-cancelled" : "completed",
    };
    await this.eventBus.emit("run_end", { messages, runId, sessionId, status });
    await this.hookManager.emit("onRunEnd", { runId, sessionId, status, messages });
  }

  private async executeToolCall(call: ModelToolCall): Promise<ToolCallRecord> {
    const tool = this.toolRegistry.get(call.name);
    if (!tool) {
      return {
        id: call.id,
        name: call.name,
        input: call.arguments,
        output: { error: `Tool not found: ${call.name}` },
        status: "error",
      };
    }

    // 权限检查
    const permission = await this.checkPermission(tool, call);
    if (!permission.allowed) {
      return {
        id: call.id,
        name: call.name,
        input: call.arguments,
        output: { error: "Permission denied", reason: permission.reason },
        status: "denied",
      };
    }

    try {
      const output = await tool.execute(call.arguments, {
        agent: this.agent,
        signal: undefined, // TODO: abort signal support
      });

      return {
        id: call.id,
        name: call.name,
        input: call.arguments,
        output,
        status: "success",
      };
    } catch (error) {
      return {
        id: call.id,
        name: call.name,
        input: call.arguments,
        output: { error: String(error) },
        status: "error",
      };
    }
  }

  private async collectContext(input: AgentInput): Promise<ContextItem[]> {
    const items: ContextItem[] = [];

    // 通过 EventBus 让各插件提供上下文
    await this.eventBus.emit("collect_context", {
      query: typeof input.content === "string" ? input.content : "",
      items,
    });

    return items;
  }

  private async checkPermission(tool: Tool, call: ModelToolCall): Promise<PermissionDecision> {
    if (!this.config.permissions) return { allowed: true };
    // 委托给权限检查逻辑（见 13-permissions.md）
    return checkToolPermission(tool, call, this.config.permissions);
  }

  async dispose(): Promise<void> {
    for (const plugin of [...(this.config.plugins ?? [])].reverse()) {
      await plugin.dispose?.();
    }
  }
}
```

---

## EventBus

贯穿全链路的事件系统，支持 typed events。

```ts
export type RunStatus = "completed" | "user-cancelled" | "error";

export type AgentEventMap = {
  run_start: { input: AgentInput; runId: string; sessionId?: string };
  run_end: {
    messages: ModelMessage[];
    runId: string;
    sessionId?: string;
    status: RunStatus;
    error?: unknown;
  };
  model_call_start: { messages: ModelMessage[] };
  model_call_end: { message: ModelMessage };
  tool_call_start: { call: ModelToolCall };
  tool_call_end: { record: ToolCallRecord };
  /**
   * 让插件（如 Memory）注入先前的 conversation history。
   * 插件把 ModelMessage[] push 进 `into`；Runtime 把它接在 system prompt 之后、
   * 当前 user input 之前。
   */
  collect_messages: { sessionId?: string; into: ModelMessage[] };
  /** 让插件注入 context items（snippet 形式，放进 system prompt 的 `<context>` 段）。 */
  collect_context: { query: string; items: ContextItem[] };
  memory_write: { item: any };
  skill_write: { skill: any };
  evolution_proposal: { type: "memory" | "skill"; proposal: any };
};

export class EventBus {
  private listeners = new Map<string, Set<Function>>();

  on<K extends keyof AgentEventMap>(
    event: K,
    handler: (payload: AgentEventMap[K]) => Promise<void> | void,
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
    return () => this.listeners.get(event)?.delete(handler);
  }

  async emit<K extends keyof AgentEventMap>(
    event: K,
    payload: AgentEventMap[K],
  ): Promise<void> {
    const handlers = this.listeners.get(event);
    if (!handlers) return;

    await Promise.all(
      [...handlers].map(handler => handler(payload)),
    );
  }
}
```

---

## ContextItem（上下文注入协议）

插件通过 `collect_context` 事件向 Runtime 注入上下文项：

```ts
export interface ContextItem {
  /** 来源插件 */
  source: string;

  /** 优先级，越高越不容易被 token budget 裁掉 */
  priority: number;

  /** 要注入 prompt 的内容 */
  content: string;

  /** 预估 token 数 */
  estimatedTokens?: number;

  /** 元数据 */
  metadata?: Record<string, unknown>;
}
```

---

## RunOptions

```ts
export interface RunOptions {
  /** 启用流式 */
  stream?: boolean;

  /** 会话 ID（用于多轮对话） */
  sessionId?: string;

  /** 用户 ID */
  userId?: string;

  /** 覆盖 maxTurns */
  maxTurns?: number;

  /** AbortSignal */
  signal?: AbortSignal;

  /** 额外元数据 */
  metadata?: Record<string, unknown>;
}
```
