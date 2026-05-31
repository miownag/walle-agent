# Phase 5 — RAG + Trace Requirements

## Why this slice

Roadmap Phase-5 acceptance (`docs/18-roadmap.md`) — closes the MVP:

- `SimpleRAGPlugin` 加载文件 → 注入到 system prompt
- `TracePlugin` 记录 run / model_call / tool_call / context_collect 事件
- JSONL 存储读写正确，跨日期分文件
- 内存存储正确执行 maxSize 淘汰

Spec sources: `docs/10-rag.md`, `docs/16-trace.md`.

## Functional requirements

### `@walle-agent/rag`

- `RAGPlugin` interface extending `WallePlugin` with `retrieve()` (+ optional `ingest` / `delete` / `list`).
- `SimpleRAGPlugin`:
  - `install()` loads files matching `patterns` under `docsPath`; chunks by `chunkSize`/`chunkOverlap`.
  - Subscribes to `collect_context` and pushes top-K hits as `[Knowledge] …` items with priority blended from the score.
  - `retrieve()` does word-overlap scoring with sensible Chinese-friendly tokenizer.
  - `ingest()` produces deterministic chunk ids `<docId>#<n>` so `delete([docId])` works.
  - Tolerates missing `docsPath` (returns empty index, never throws).
- Exports: `SimpleRAGPlugin` + types.

### `@walle-agent/trace`

- `TraceStore` interface: `write` / `query` / `getTrace` / optional `dispose`.
- `JSONLTraceStore`: one file per UTC date, append-only; query walks reverse-chronological so `limit` returns most recent first; tolerates malformed lines.
- `InMemoryTraceStore`: ring buffer with `maxSize` (default 10000); query returns defensive copies.
- `TracePlugin`:
  - Subscribes to `run_start` / `run_end` / `model_call_*` / `tool_call_*` / `collect_context` / `memory_write` / `skill_write` / `evolution_proposal`.
  - `recordContent: false` by default — redacts user input, tool arguments, message content, proposals.
  - `sampleRate` random drop.
  - `customStore` injection beats `store`/`storePath`.
  - Store write errors are logged + swallowed (must never crash a run).

## Non-functional requirements

- No core changes — Phase 5 is purely additive.
- Match the package conventions of `@walle-agent/sandbox` / `@walle-agent/team` (peer-dep, tsup external, vitest unit tests, no real LLM/network calls).
- Examples for both plugins under `examples/`, wired into `examples/package.json` + root `package.json` scripts.

## Out of scope (deferred)

- `@walle-agent/rag-qdrant` — external vector backend.
- `@walle-agent/trace-otel` — OpenTelemetry adapter (interface-ready via `customStore`).
- TypeDoc generation.
- Top-level README guides — code-level JSDoc + per-package package.json descriptions are sufficient for MVP.
