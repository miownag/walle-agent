# Phase 5 — RAG + Trace Testing

## Unit tests

### `packages/rag/tests/simple-rag-plugin.test.ts` (14 tests)

**Constructor**
- Throws when `docsPath` is missing.

**`loadDocs`**
- Walks `docsPath` recursively; loads files matching default patterns (`.md`, `.txt`); ignores other extensions.
- Honours custom patterns by file extension.
- ENOENT on `docsPath` is silently a no-op.
- Long content is split into multiple chunks at the configured size with overlap.

**`retrieve`**
- Returns hits scored by query word overlap, sorted desc; minScore filters out low-overlap hits.
- Honours `topK`.
- Honours `minScore` override.
- Empty / whitespace-only query returns `[]`.

**`collect_context` integration**
- Auto-injects retrieval results when `injectContext: true` (default); items have `source: "rag"`, blended priority, estimatedTokens.
- `injectContext: false` skips subscription.

**`ingest` / `delete` / `list`**
- `ingest` of a long document produces multiple `<id>#<n>` chunks.
- `delete([docId])` removes every chunk for that doc id.
- `list()` returns one entry per parent document id.

### `packages/trace/tests/in-memory-trace-store.test.ts` (5 tests)
- `write` + `getTrace` round-trip.
- `query` filters: traceId / types / since / until / limit.
- Evicts oldest when `maxSize` is exceeded.
- Query results are defensive copies.
- `dispose()` clears.

### `packages/trace/tests/jsonl-trace-store.test.ts` (5 tests)
- `write` creates one file per UTC date and appends one line per event.
- `query` returns `[]` when directory does not exist.
- `query` honours all filters.
- Walks files in reverse-chronological order so `limit` returns most recent first.
- Ignores malformed lines silently.

### `packages/trace/tests/trace-plugin.test.ts` (10 tests)

**Store selection**
- Defaults to `JSONLTraceStore`.
- `store: "memory"` selects `InMemoryTraceStore`.
- `customStore` beats both.

**Event recording**
- `run_start` mints a fresh traceId; subsequent events share it.
- Redacts content by default; honours `recordContent: true`.
- Records `tool_call_start` + `tool_call_end` with name/status/durationMs.
- Records `context_collect` with item count and sources; redacts query by default.
- `sampleRate < 1` randomly drops events.
- Never throws when underlying store fails (logs + continues).

**Lifecycle**
- `dispose()` forwards to `store.dispose()`.

## Build

- `pnpm --filter @walle-agent/rag build` — clean ESM (5.26 KB) + CJS (6.87 KB) + d.ts (3.95 KB).
- `pnpm --filter @walle-agent/trace build` — clean ESM (7.95 KB) + CJS (9.65 KB) + d.ts (5.02 KB).
- `pnpm build` (full monorepo) — clean across 11 packages.

## Full suite

- `pnpm test` — **321 passed (41 files)**, up from 287 before this slice (+34 RAG/Trace tests).

## Manual smoke (recommended)

1. **RAG e2e** — `pnpm rag` after seeding `.env`. Expect both deployment / support questions to be answered from the seeded markdown.
2. **Trace e2e** — `pnpm trace`. Expect a `.walle/traces/<date>.jsonl` file containing run_start → model_call_start → model_call_end → run_end events, all sharing one traceId.
3. **Trace + RAG composition** — load both plugins on the same agent; verify traces include `context_collect` events with `source: "rag"` listed.

## Phase 5 status after this slice

```
Phase 5 — RAG + Trace + Polish   ✅ COMPLETE
- [x] SimpleRAGPlugin 加载文件 → 注入到 system prompt
- [x] TracePlugin 记录 run / model_call / tool_call / context_collect 事件
- [x] JSONL 存储读写正确，跨日期分文件
- [x] 内存存储正确执行 maxSize 淘汰
- [x] 全量测试 321 passing
```
