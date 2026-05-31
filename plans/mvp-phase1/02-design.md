# MVP Phase 1 — Design

## Architecture

Follows `docs/01-architecture.md` — micro-core + plugin architecture.

## Key Design Decisions

1. **Stream-first execution loop**: AsyncGenerator-based. Non-streaming is `stream.collect()`.
2. **Zero external deps for core**: Only `@types/node` in devDeps.
3. **EventBus for plugin context injection**: Plugins listen on `collect_context` to inject data.
4. **HookManager with parallel broadcast**: `Promise.allSettled` ensures one hook failure doesn't block others.
5. **MiddlewarePipeline with onion model**: beforeInput/beforeModel forward, afterOutput reverse.
6. **TokenBudget basic allocator**: Sort by priority, fit within budget, trim excess.
7. **PromptBuilder**: Assembles system + context items + user message.

## Package Structure

Refer to `docs/02-package-structure.md` for full details.

Implemented in this phase:
- `@walle-agent/core` — Agent, Runtime, Tools, Events, Hooks, Middleware, Stream, TokenBudget, PromptBuilder
- `@walle-agent/openai` — OpenAI provider + message adapter
- `@walle-agent/anthropic` — Anthropic provider + message adapter

## Spec References

- `docs/03-core-runtime.md` — Agent, AgentRuntime, EventBus, ContextItem
- `docs/04-streaming.md` — AgentStream, AgentStreamEvent
- `docs/05-llm-provider.md` — LLMProvider interface, message types
- `docs/06-tools.md` — Tool interface, ToolRegistry
- `docs/12-hooks-middleware.md` — Hooks + Middleware systems
