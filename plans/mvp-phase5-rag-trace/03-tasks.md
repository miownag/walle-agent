# Phase 5 — RAG + Trace Tasks

## Done

### RAG package
- [x] `packages/rag/package.json` — peer-dep `@walle-agent/core`; no runtime deps.
- [x] `packages/rag/tsconfig.json` — extends base.
- [x] `packages/rag/tsup.config.ts` — external `@walle-agent/core`.
- [x] `packages/rag/src/rag-types.ts` — RAGPlugin interface, request/context types, SimpleRAGConfig, RAGChunk.
- [x] `packages/rag/src/simple-rag-plugin.ts` — full SimpleRAGPlugin with loadDocs, retrieve, ingest, delete, list, collect_context auto-inject, helpers.
- [x] `packages/rag/src/index.ts` — public exports.
- [x] `packages/rag/tests/simple-rag-plugin.test.ts` — 14 tests.

### Trace package
- [x] `packages/trace/package.json` — peer-dep `@walle-agent/core`.
- [x] `packages/trace/tsconfig.json` — extends base.
- [x] `packages/trace/tsup.config.ts` — external `@walle-agent/core`.
- [x] `packages/trace/src/trace-types.ts` — TraceEvent, TraceQuery, TraceStore, TracePluginConfig.
- [x] `packages/trace/src/in-memory-trace-store.ts` — InMemoryTraceStore + maxSize / dispose.
- [x] `packages/trace/src/jsonl-trace-store.ts` — JSONLTraceStore with reverse-chrono read + bad-line tolerance.
- [x] `packages/trace/src/trace-plugin.ts` — full subscription set, recordContent redaction, sampleRate, customStore, fail-safe writes.
- [x] `packages/trace/src/index.ts` — public exports.
- [x] `packages/trace/tests/in-memory-trace-store.test.ts` — 5 tests.
- [x] `packages/trace/tests/jsonl-trace-store.test.ts` — 5 tests.
- [x] `packages/trace/tests/trace-plugin.test.ts` — 10 tests.

### Examples
- [x] `examples/rag.ts` — seeds a small KB, runs two queries.
- [x] `examples/trace.ts` — wires JSONL store, runs an agent, prints recorded events.
- [x] `examples/package.json` + root `package.json` — `pnpm rag` / `pnpm trace` shortcuts.

### Spec sync
- [x] `docs/18-roadmap.md` — Phase 5 acceptance: all boxes ticked, deferred items marked ⏭.
- [x] `docs/10-rag.md` — 实现备忘 (loadDocs glob choice, chunk id scheme, tokenizer, injectContext opt-out, ENOENT tolerance).
- [x] `docs/16-trace.md` — 实现备忘 (default redaction, fail-safe writes, customStore, wider subscription set, malformed-line tolerance, injectable maxSize, dispose lifecycle).
- [x] `plans/mvp-phase5-rag-trace/{01-requirements,02-design,03-tasks,04-testing}.md`.

## Out of scope (deferred)

- `@walle-agent/rag-qdrant` — external vector backend; needs an embeddings-capable provider.
- `@walle-agent/trace-otel` — OpenTelemetry adapter; reachable today via `customStore`, but the package itself ships in Phase 6.
- TypeDoc API site — would need a docs build pipeline; deferred until 1.0.
- Top-level README guides — JSDoc on plugin entry points covers MVP needs.
- Embedding-based retrieval inside SimpleRAG — by design, that's a separate plugin.
