# Phase 5 — RAG + Trace Design

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│ @walle-agent/rag                                                       │
│                                                                        │
│  SimpleRAGPlugin(config)                                               │
│   ├─► install(ctx)                                                     │
│   │     ├─ loadDocs() walk docsPath, filter by ext, chunk content      │
│   │     └─ events.on("collect_context", autoInject)                    │
│   ├─► retrieve(req)         word-overlap scoring                       │
│   ├─► ingest(docs)           split + push chunks (id "<docId>#<n>")    │
│   ├─► delete(ids)            removes by chunk id OR parent doc id      │
│   └─► list()                 dedupe parents from chunk ids             │
└────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────┐
│ @walle-agent/trace                                                     │
│                                                                        │
│  TracePlugin(config)                                                   │
│   ├─► createStore()                                                    │
│   │     ├─ customStore (if provided)                                   │
│   │     ├─ "memory" → InMemoryTraceStore                               │
│   │     └─ "jsonl"  → JSONLTraceStore(storePath)                       │
│   ├─► install(ctx)                                                     │
│   │     ├─ on run_start  → mint traceId, record                        │
│   │     ├─ on run_end / model_call_* / tool_call_* /                   │
│   │     │   collect_context / memory_write / skill_write /             │
│   │     │   evolution_proposal → record                                │
│   │     └─ all writes try/catch, console.error on failure              │
│   └─► getStore() / getCurrentTraceId()                                 │
│                                                                        │
│  JSONLTraceStore                                                       │
│   ├─ write  → append `<dirPath>/<YYYY-MM-DD>.jsonl`                    │
│   └─ query  → reverse-chrono walk, parse line by line, skip bad lines  │
│                                                                        │
│  InMemoryTraceStore                                                    │
│   ├─ ring buffer, slice tail when > maxSize                            │
│   └─ query returns defensive copies                                    │
└────────────────────────────────────────────────────────────────────────┘
```

## Module layout

```
packages/rag/
├── package.json              peer-dep @walle-agent/core
├── tsconfig.json
├── tsup.config.ts            external: ["@walle-agent/core"]
├── src/
│   ├── index.ts
│   ├── rag-types.ts          RAGPlugin, RAGContext, …, SimpleRAGConfig, RAGChunk
│   └── simple-rag-plugin.ts  SimpleRAGPlugin + tokenize / estimateTokens helpers
└── tests/simple-rag-plugin.test.ts   14 tests

packages/trace/
├── package.json              peer-dep @walle-agent/core
├── tsconfig.json
├── tsup.config.ts            external: ["@walle-agent/core"]
├── src/
│   ├── index.ts
│   ├── trace-types.ts            TraceEvent, TraceStore, TracePluginConfig, …
│   ├── in-memory-trace-store.ts  InMemoryTraceStore
│   ├── jsonl-trace-store.ts      JSONLTraceStore
│   └── trace-plugin.ts           TracePlugin
└── tests/
    ├── in-memory-trace-store.test.ts   5 tests
    ├── jsonl-trace-store.test.ts       5 tests
    └── trace-plugin.test.ts            10 tests
```

Mirrors `packages/sandbox/` (peer-dep + tsup external + vitest unit).

## Key implementation choices

### RAG

- **No glob dep**: patterns interpreted as `**/*.<ext>` suffix-match. `fs.readdir({ recursive: true })` (Node 20+) walks recursively. Cheap, zero dependencies.
- **Chinese-friendly tokenizer**: `split(/[^a-z0-9_一-鿿]+/)` so non-Latin documents at least produce tokens.
- **Deterministic chunk ids**: `<docId>#<n>` enables `delete([docId])` to wipe every chunk for a document.
- **Robust loadDocs**: `ENOENT` on `docsPath` is a no-op (empty knowledge base). Per-file `stat`/`readFile` errors skip silently — don't poison the index.
- **`injectContext` opt-out**: default `true`; `false` lets users wire RAG manually (e.g. via tools) or compare backends side-by-side.

### Trace

- **`recordContent: false` by default**: trace data can leak into prod logging; default redacts user input, tool args, message content, and evolution proposals.
- **`customStore` beats discriminator**: lets users inject a fully custom `TraceStore` (OTEL, ClickHouse, in-test spy) without forking. `store: "memory"` becomes a sugar for the common case.
- **Never crash the run**: `record` wraps `store.write` in try/catch; failures are `console.error`'d. Trace is observability, not a critical path.
- **Wider event subscription set**: spec listed run/model_call/tool_call. Implementation adds `collect_context`, `memory_write`, `skill_write`, `evolution_proposal` so Phase-6 evolution has the full signal.
- **`InMemoryTraceStore.maxSize` injectable**: useful for sizing tests.
- **JSONL malformed-line tolerance**: skip silently. Reverse-chrono file walk so `limit` returns most-recent matches first.

## Public API surface

```ts
// @walle-agent/rag
export { SimpleRAGPlugin };
export type { RAGPlugin, RAGRetrieveRequest, RAGContext, RAGDocument,
              RAGDocumentInfo, RAGChunk, SimpleRAGConfig };

// @walle-agent/trace
export { TracePlugin, JSONLTraceStore, InMemoryTraceStore };
export type { TraceEvent, TraceEventType, TraceQuery, TraceStore,
              TracePluginConfig, InMemoryTraceStoreOptions };
```
