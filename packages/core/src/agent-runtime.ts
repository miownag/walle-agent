/**
 * AgentRuntime — the execution engine.
 * Implements the streaming-first execution loop.
 */

import type { Agent } from "./agent.js";
import type {
  AgentInput,
  ResolvedAgentConfig,
  RunOptions,
} from "./agent-config.js";
import type { PermissionDecision } from "./permissions.js";
import { checkToolPermission } from "./permissions.js";
import type { ModelMessage, ModelToolCall } from "./message.js";
import type { Tool, ToolCallRecord } from "./tool.js";
import { ToolRegistry } from "./tool-registry.js";
import { HookManager } from "./hooks.js";
import { MiddlewarePipeline } from "./middleware.js";
import { EventBus, type ContextItem, type RunStatus } from "./events.js";
import { TokenBudget } from "./token-budget.js";
import { PromptBuilder } from "./prompt-builder.js";
import { AgentContextImpl } from "./agent-context.js";
import { AgentStream, type AgentStreamEvent } from "./stream.js";
import { BUILTIN_TOOLS } from "./builtin-tools/index.js";
import { createTaskTool, TASK_TOOL_NAME } from "./builtin-tools/task-tool.js";
import { SubAgentRegistry } from "./sub-agent-registry.js";
import { mergeAbortSignals } from "./signal-utils.js";

interface ActiveRun {
  id: string;
  controller: AbortController;
}

export class AgentRuntime {
  private toolRegistry: ToolRegistry;
  private hookManager: HookManager;
  private middlewarePipeline: MiddlewarePipeline;
  private pluginContext: AgentContextImpl;
  private eventBus: EventBus;
  private tokenBudget: TokenBudget;
  private promptBuilder: PromptBuilder;
  /**
   * Per-Agent registry of sub-agent types consumed by the built-in `task`
   * tool. Pre-populated from `config.subAgents`; plugins (e.g. team's
   * `SubAgentsPlugin`) can also register entries via `ctx.subAgents`.
   */
  private subAgentRegistry: SubAgentRegistry;

  /** The currently-running run, if any. Consulted by `interrupt()`. */
  private activeRun: ActiveRun | null = null;

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

    this.subAgentRegistry = new SubAgentRegistry();
    for (const def of config.subAgents) {
      this.subAgentRegistry.register(def);
    }

    this.pluginContext = new AgentContextImpl({
      agent: this.agent,
      config: this.config,
      events: this.eventBus,
      toolRegistry: this.toolRegistry,
      hookManager: this.hookManager,
      middlewarePipeline: this.middlewarePipeline,
      subAgents: this.subAgentRegistry,
    });
  }

  async init(): Promise<void> {
    // 1. Register built-in tools (before user tools, so user can override)
    this.registerBuiltinTools();

    // 2. Register native tools
    for (const tool of this.config.tools) {
      this.toolRegistry.register(tool);
    }

    // 3. Register shorthand hooks
    if (this.config.hooks) {
      this.hookManager.registerAll(this.config.hooks);
    }

    // 4. Register shorthand middleware
    for (const mw of this.config.middleware) {
      this.middlewarePipeline.use(mw);
    }

    // 5. Install plugins (sequential).
    //    Plugins MAY register sub-agent types via ctx.subAgents — those
    //    additions need to be reflected in the task tool's description, so
    //    the task tool itself is registered after this loop.
    for (const plugin of this.config.plugins) {
      await plugin.install(this.pluginContext);
    }

    // 6. Register the per-agent `task` tool now that subAgentRegistry is
    //    fully populated (config.subAgents + any plugin contributions).
    this.registerTaskTool();

    await this.hookManager.emit("onInit", this.pluginContext);
  }

  private registerBuiltinTools(): void {
    const config = this.config.useBuiltinTools;

    // Disabled entirely
    if (config === false) return;

    let toolsToRegister: Tool[] = BUILTIN_TOOLS;

    // Fine-grained include/exclude
    if (typeof config === "object") {
      if (config.includeTools && config.includeTools.length > 0) {
        const includeSet = new Set(config.includeTools);
        toolsToRegister = BUILTIN_TOOLS.filter((t) => includeSet.has(t.name));
      } else if (config.excludeTools && config.excludeTools.length > 0) {
        const excludeSet = new Set(config.excludeTools);
        toolsToRegister = BUILTIN_TOOLS.filter((t) => !excludeSet.has(t.name));
      }
    }

    for (const tool of toolsToRegister) {
      this.toolRegistry.register(tool);
    }
  }

  /**
   * Register the per-agent `task` tool. Called after plugins install so the
   * tool description reflects every sub-agent type (config.subAgents +
   * plugin-registered ones).
   *
   * Honors `useBuiltinTools` exclude/include rules for the "task" name and
   * silently skips registration if the user already supplied a tool with
   * that name (so they can override).
   */
  private registerTaskTool(): void {
    const config = this.config.useBuiltinTools;
    if (config === false) return;

    if (typeof config === "object") {
      if (config.includeTools && config.includeTools.length > 0) {
        if (!config.includeTools.includes(TASK_TOOL_NAME)) return;
      } else if (config.excludeTools && config.excludeTools.includes(TASK_TOOL_NAME)) {
        return;
      }
    }

    // Respect explicit user override: if a tool named "task" was passed via
    // config.tools, leave it alone (matches the "user can override built-in"
    // contract).
    if (this.toolRegistry.has(TASK_TOOL_NAME)) return;

    const taskTool = createTaskTool({
      registry: this.subAgentRegistry,
      defaultModel: this.config.model,
      defaultMaxTurns: this.config.maxTurns,
    });
    this.toolRegistry.register(taskTool);
  }

  /**
   * Expose the per-Agent SubAgentRegistry for plugins / advanced consumers.
   * Plugins (e.g. team's `SubAgentsPlugin`) register types via
   * `ctx.subAgents.register(...)` during install — the same registry already
   * wired into the built-in `task` tool.
   */
  getSubAgentRegistry(): SubAgentRegistry {
    return this.subAgentRegistry;
  }
  /** Reference TASK_TOOL_NAME so static typecheck flags accidental drift. */
  static readonly TASK_TOOL_NAME = TASK_TOOL_NAME;

  /**
   * Non-streaming execution: internally calls stream, collects all events.
   */
  async run(input: string | AgentInput, options?: RunOptions): Promise<import("./agent-config.js").AgentResult> {
    const stream = this.stream(input, options);
    return stream.collect();
  }

  /**
   * Streaming execution: core execution loop.
   * Returns AgentStream (AsyncIterable<AgentStreamEvent>).
   */
  stream(input: string | AgentInput, options?: RunOptions): AgentStream {
    const normalizedInput = this.normalizeInput(input, options);
    return new AgentStream(this.executeGenerator(normalizedInput, options));
  }

  /**
   * Request interruption of the in-flight run, if any.
   * No-op when idle. Called from `Agent.interrupt`.
   */
  requestInterrupt(reason?: string): void {
    this.activeRun?.controller.abort(reason ?? "user-interrupt");
  }

  /** Whether a run is currently in flight. */
  isRunning(): boolean {
    return this.activeRun !== null;
  }

  /**
   * Core execution generator.
   */
  private async *executeGenerator(
    input: AgentInput,
    options?: RunOptions,
  ): AsyncGenerator<AgentStreamEvent> {
    if (this.activeRun) {
      throw new Error(
        `Agent "${this.config.name}" is already running (runId=${this.activeRun.id}). ` +
          `Call agent.interrupt() or await the existing run before starting a new one.`,
      );
    }

    const runId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sessionId = input.sessionId;

    const internalController = new AbortController();
    this.activeRun = { id: runId, controller: internalController };
    const signal = mergeAbortSignals(options?.signal, internalController.signal);

    let status: RunStatus = "completed";
    let runError: unknown | undefined;
    /**
     * The full in-memory message list used this run. Hoisted here so the
     * `finally` block can forward it to `run_end`/`onRunEnd` for plugins
     * (e.g. EvolutionPlugin) that observe the conversation post-hoc.
     */
    let messages: ModelMessage[] = [];

    // Helper: did the user cancel?
    const userCancelled = () => signal.aborted;

    try {
      // 1. Middleware: beforeInput
      const processedInput = await this.middlewarePipeline.beforeInput(input);

      // 2. Emit run_start + hook
      yield { type: "run_start", input: processedInput, runId, sessionId };
      await this.eventBus.emit("run_start", { input: processedInput, runId, sessionId });
      await this.hookManager.emit("onRunStart", { input: processedInput, runId, sessionId });

      if (userCancelled()) {
        status = "user-cancelled";
        return;
      }

      // 3. Collect conversation history from plugins (Memory)
      const history = await this.collectMessages(sessionId);

      // 4. Collect context from plugins (Memory/Skills/RAG)
      const contextItems = await this.collectContext(processedInput);

      // 5. Token budget allocation
      const budget = this.tokenBudget.allocate(contextItems);

      // 6. Build message list
      messages = this.promptBuilder.build({
        systemPrompt: this.config.systemPrompt,
        input: processedInput,
        context: budget.items,
        tools: this.toolRegistry.list(),
        conversationHistory: history,
      });

      // 7. Execution loop
      const maxTurns = options?.maxTurns ?? this.config.maxTurns;

      for (let turn = 0; turn < maxTurns; turn++) {
        if (userCancelled()) {
          status = "user-cancelled";
          return;
        }

        await this.hookManager.emit("beforeModelCall", { messages });

        yield { type: "model_call_start", turn };

        // Stream LLM call. The signal is threaded into the request so compliant
        // providers (anything using fetch / SDK clients that accept a signal)
        // will throw/settle when the user interrupts.
        const llmStream = this.config.model.stream({
          messages,
          tools: this.toolRegistry.list().length > 0 ? this.toolRegistry.toModelTools() : undefined,
          signal,
        });

        let assistantMessage: ModelMessage | null = null;
        let toolCalls: ModelToolCall[] = [];

        try {
          for await (const chunk of llmStream) {
            if (userCancelled()) {
              status = "user-cancelled";
              return;
            }

            yield { type: "llm_chunk", chunk };

            if (chunk.type === "text_delta") {
              yield { type: "text_delta", content: chunk.content };
            }

            if (chunk.type === "tool_call_delta") {
              yield {
                type: "tool_call_delta",
                toolCallId: chunk.toolCallId,
                name: chunk.name,
                argumentsDelta: chunk.argumentsDelta,
              };
            }

            if (chunk.type === "message_complete") {
              assistantMessage = chunk.message;
              toolCalls = chunk.toolCalls ?? [];
            }

            if (chunk.type === "error") {
              yield { type: "error", error: chunk.error };
              status = "error";
              runError = chunk.error;
              return;
            }
          }
        } catch (streamErr) {
          // The provider threw — usually because its underlying fetch/SDK saw
          // the aborted signal. If that's the case, report as user-cancelled;
          // otherwise bubble as a regular run error.
          if (userCancelled()) {
            status = "user-cancelled";
            return;
          }
          throw streamErr;
        }

        if (!assistantMessage) {
          if (userCancelled()) {
            // Stream was aborted by the user before the model emitted
            // `message_complete`; treat it as a clean cancellation, not an error.
            status = "user-cancelled";
            return;
          }
          const err = new Error("LLM stream ended without complete message");
          yield { type: "error", error: err };
          status = "error";
          runError = err;
          return;
        }

        messages.push(assistantMessage);
        yield { type: "model_call_end", message: assistantMessage };
        await this.eventBus.emit("model_call_end", { message: assistantMessage });
        await this.hookManager.emit("afterModelCall", { message: assistantMessage });

        // No tool calls — end loop
        if (!toolCalls.length) {
          break;
        }

        // Execute tool calls
        for (const call of toolCalls) {
          if (userCancelled()) {
            status = "user-cancelled";
            return;
          }

          yield { type: "tool_call_start", call };
          await this.eventBus.emit("tool_call_start", { call });
          await this.hookManager.emit("beforeToolCall", { call });

          const record = await this.executeToolCall(call, signal);

          yield { type: "tool_call_end", record };
          await this.eventBus.emit("tool_call_end", { record });
          await this.hookManager.emit("afterToolCall", { record });

          messages.push({
            role: "tool",
            toolCallId: call.id,
            content: this.serializeToolOutput(record.output),
          });
        }
      }
    } catch (err) {
      status = "error";
      runError = err;
      yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) };
      await this.hookManager.emit("onRunError", { error: err, runId, sessionId });
    } finally {
      // Final status override: if signal was aborted anywhere, report cancelled.
      if (userCancelled() && status !== "error") {
        status = "user-cancelled";
      }

      yield {
        type: "run_end",
        runId,
        sessionId,
        status,
        error: runError,
      };
      await this.eventBus.emit("run_end", {
        messages,
        runId,
        sessionId,
        status,
        error: runError,
      });
      await this.hookManager.emit("onRunEnd", {
        runId,
        sessionId,
        status,
        messages,
      });

      // Release the "active run" slot so a subsequent `agent.run(...)` works.
      if (this.activeRun?.id === runId) {
        this.activeRun = null;
      }
    }
  }

  private async executeToolCall(
    call: ModelToolCall,
    signal: AbortSignal | undefined,
  ): Promise<ToolCallRecord> {
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

    // Permission check
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

    const startTime = Date.now();
    try {
      const output = await tool.execute(call.arguments, {
        agent: this.agent,
        signal,
      });

      return {
        id: call.id,
        name: call.name,
        input: call.arguments,
        output,
        status: "success",
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        id: call.id,
        name: call.name,
        input: call.arguments,
        output: { error: String(error) },
        status: "error",
        durationMs: Date.now() - startTime,
        error: String(error),
      };
    }
  }

  private async collectContext(input: AgentInput): Promise<ContextItem[]> {
    const items: ContextItem[] = [];
    const query = typeof input.content === "string" ? input.content : "";

    await this.eventBus.emit("collect_context", { query, items });

    return items;
  }

  private async collectMessages(sessionId: string | undefined): Promise<ModelMessage[]> {
    const into: ModelMessage[] = [];
    await this.eventBus.emit("collect_messages", { sessionId, into });
    return into;
  }

  private async checkPermission(tool: Tool, call: ModelToolCall): Promise<PermissionDecision> {
    if (!this.config.permissions) return { allowed: true };
    return checkToolPermission(tool, call, this.config.permissions);
  }

  private normalizeInput(input: string | AgentInput, options?: RunOptions): AgentInput {
    const base: AgentInput = typeof input === "string"
      ? { content: input }
      : input;

    return {
      ...base,
      sessionId: base.sessionId ?? options?.sessionId ?? this.config.sessionId,
      userId: base.userId ?? options?.userId,
      metadata: { ...base.metadata, ...options?.metadata },
    };
  }

  private serializeToolOutput(output: unknown): string {
    if (typeof output === "string") return output;
    try {
      return JSON.stringify(output);
    } catch {
      return String(output);
    }
  }

  async dispose(): Promise<void> {
    for (const plugin of [...this.config.plugins].reverse()) {
      await plugin.dispose?.();
    }
  }
}
