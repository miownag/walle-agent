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

  /** 内置文件系统工具的可选工作区边界；省略时沿用 process.cwd() */
  workspaceRoot?: string;

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

`workspaceRoot` 会原样进入 `ResolvedAgentConfig`。当它存在时，
`AgentRuntime` 为当前 Agent 单独调用 `createFilesystemTools({ workspaceRoot })`，
而不是注册模块级文件工具；`ls` / `read_file` / `write_file` / `edit_file` /
`glob` / `grep` 的相对路径均以该目录为基准。未设置时继续注册公开的模块级
tools，保持历史 `process.cwd()` 行为。动态 `task` 子 Agent 继承父 Agent 的
`workspaceRoot`，不会意外回退到进程工作目录。

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

`PromptBuilder` 只把 `attachments` 合并到本次新建的 `role: "user"` 消息，不修改 system/history：

- `image`：要求合法 `image/*` MIME；`Buffer` 编码成 base64，string 按 base64 校验并规范化，然后生成 `ImageBlock.source.type = "base64"`。
- `url`：只接受 HTTP(S)，生成 URL `ImageBlock`，不在 core 内抓取资源。
- `file`：当前仅生成带 name/MIME/path 的文本描述，不读取本地文件。
- 每个附件会先追加一个不含 image base64 的可追踪文本 block；若原始 `content` 已是 `ContentBlock[]`，保留原 blocks 并在末尾追加附件 blocks。
- 非法 MIME、base64、URL scheme 或 file data 会同步抛出带 attachment index 的 `TypeError`，不会静默丢附件或构造畸形 provider 请求。

Memory 的 `onRunStart` 仍只持久化原始 `input.content`；图片 bytes 是当前请求的 transient payload，不进入 `messages.jsonl`。

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
    // 1. 注册 built-ins；workspaceRoot 存在时文件工具由 factory 单独构造
    this.registerBuiltinTools();

    // 2. 注册原生工具（同名时覆盖 built-in）
    for (const tool of this.config.tools ?? []) {
      this.toolRegistry.register(tool);
    }

    // 3. 注册快捷 hooks
    if (this.config.hooks) {
      this.hookManager.registerAll(this.config.hooks);
    }

    // 4. 注册快捷 middleware
    for (const mw of this.config.middleware ?? []) {
      this.middlewarePipeline.use(mw);
    }

    // 5. 安装插件（顺序执行）
    for (const plugin of this.config.plugins ?? []) {
      await plugin.install(this.pluginContext);
    }

    // 6. 构造需要 per-Agent 状态的 task / web_fetch / tool-search helpers
    this.registerTaskTool();
    this.registerWebFetchTool();
    this.applyToolSearchPolicy();

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

        if (chunk.type === "thinking_delta") {
          yield { type: "thinking_delta", content: chunk.content };
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
  /** 每个 turn 顶部的可变 micro-compaction pass。 */
  compact_messages: {
    messages: ModelMessage[];
    keepRecentTurns: number;
    runId: string;
    sessionId?: string;
  };
  /** 成功 macro-compaction 的只读结果快照，供 Memory 原子持久化。 */
  compaction_done: {
    runId: string;
    sessionId?: string;
    before: number;
    after: number;
    summary: string;
    messages: ReadonlyArray<ModelMessage>;
  };
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

## Active-run guidance

`agent.steer(input)` accepts string or AgentInput and returns whether the active run accepted it. Inputs pass through beforeInput middleware and enter the conversation at the next model boundary. Outstanding tool calls retain their paired results before guidance is inserted. The runtime emits input_steered with the processed input; its EventBus payload also includes the user ModelMessage for memory persistence. When idle or cancelled, steer returns false.
