# MVP Phase 1 — Tasks

## Completed

- [x] Set up monorepo infrastructure (pnpm workspace, tsconfig, tsup, vitest)
- [x] Implement `@walle-agent/core` package
  - [x] types.ts — JSONSchema, TokenUsage, Attachment
  - [x] message.ts — ModelMessage, ContentBlock, ModelToolCall
  - [x] llm-provider.ts — LLMProvider interface, LLMStreamChunk
  - [x] tool.ts — Tool interface, defineTool helper
  - [x] tool-registry.ts — ToolRegistry with toModelTools
  - [x] events.ts — EventBus, AgentEventMap, ContextItem
  - [x] hooks.ts — AgentHooks, HookManager
  - [x] middleware.ts — Middleware, MiddlewarePipeline
  - [x] plugin.ts — WallePlugin interface
  - [x] agent-config.ts — AgentConfig, AgentInput, AgentResult, RunOptions
  - [x] token-budget.ts — TokenBudget allocator
  - [x] prompt-builder.ts — PromptBuilder
  - [x] agent-context.ts — AgentContext interface + AgentContextImpl
  - [x] agent-runtime.ts — AgentRuntime execution loop
  - [x] agent.ts — Agent class (create, run, dispose)
  - [x] stream.ts — AgentStream, AgentStreamEvent types
  - [x] index.ts — Public API exports
- [x] Implement `@walle-agent/openai` provider
  - [x] message-adapter.ts — toOpenAI/fromOpenAI/transformStream
  - [x] openai-provider.ts — OpenAIProvider class
- [x] Implement `@walle-agent/anthropic` provider
  - [x] message-adapter.ts — toAnthropic/fromAnthropic/transformStream
  - [x] anthropic-provider.ts — AnthropicProvider class (with thinking support)
- [x] Write unit tests (EventBus, ToolRegistry, HookManager, Middleware, Stream)
- [x] Write integration tests (full Agent loop with MockProvider)
- [x] Write examples (basic-agent.ts, streaming.ts)
- [x] Verify build + test pass

## Date

Completed: 2026/05/04
