# MVP Phase 1 — Requirements

## Goal

Implement the Phase 1 of Walle Agent SDK as defined in `docs/18-roadmap.md`:
- Core Runtime with stable Tool Call + Streaming + plugin extensibility
- OpenAI, Anthropic LLM Providers

## Acceptance Criteria

- [x] `agent.run("hello")` returns correct result (non-streaming)
- [x] `agent.run("hello", { stream: true })` returns stream events
- [x] Tool Call correctly executed and fed back to LLM loop
- [x] Hooks fire at correct lifecycle points
- [x] Middleware can modify input/output
- [x] OpenAI, Anthropic build and type-check
- [x] Plugin registration mechanism works (install, dispose, registerTool, registerHook)

## Out of Scope

- Memory, Skills, Evolution (Phase 2)
- MCP, Sandbox, Permissions (Phase 3)
- Team/Swarm (Phase 4)
- RAG, Trace (Phase 5)
