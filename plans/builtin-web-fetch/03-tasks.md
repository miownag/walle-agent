# Built-in `web_fetch` — Tasks

> Tracks the implementation of the `web_fetch` built-in tool.

## Status: ✅ DONE

## Implementation tasks

### 1. ✅ `packages/core/src/builtin-tools/web-fetch-tool.ts`
- `WEB_FETCH_NAME` constant
- `WebFetchInput` / `WebFetchOutput` types (success / redirect / error)
- `CreateWebFetchOptions` (model, maxContentChars, defaultTimeout, userAgent,
  fetchImpl, disableCache)
- `htmlToMarkdown(html)` — zero-dep HTML → markdown
- 15-minute in-memory cache (`getCached` / `setCached` / `clearWebFetchCache`)
- `fetchOnce` recursive helper with manual redirect handling and a hard
  redirect cap of 5 hops
- `createWebFetchTool({ model, … })` factory returning a `Tool`

### 2. ✅ `packages/core/src/builtin-tools/index.ts`
- Re-export `createWebFetchTool`, `WEB_FETCH_NAME`, `htmlToMarkdown`,
  `clearWebFetchCache`
- Re-export the public types
- Update file header comment to document the new per-agent tool

### 3. ✅ `packages/core/src/agent-runtime.ts`
- Import `createWebFetchTool`, `WEB_FETCH_NAME`
- New private method `registerWebFetchTool()` honouring
  `useBuiltinTools.{includeTools, excludeTools}`, user overrides, and a
  silent skip when `globalThis.fetch` is unavailable
- Call `registerWebFetchTool()` in `init()` after `registerTaskTool()` and
  before `applyToolSearchPolicy()`

### 4. ✅ `packages/core/src/index.ts`
- Export `createWebFetchTool`, `WEB_FETCH_NAME`, `htmlToMarkdown`,
  `clearWebFetchCache`
- Export the public types

### 5. ✅ `packages/core/tests/web-fetch-tool.test.ts`
- htmlToMarkdown: 4 unit tests (title, script/style stripping, headings/links/lists, entities)
- createWebFetchTool: 12 tests
  - registers under canonical name with builtin tag
  - validates required url + prompt
  - rejects unsupported protocols
  - upgrades http:// to https://
  - returns structured cross-host redirect
  - follows same-host redirect transparently
  - propagates HTTP errors with status
  - forwards markdown to model and returns answer
  - caches identical (url, prompt, model) tuples
  - truncates over-long content
  - pretty-prints JSON content type
  - structured error when summariser throws

### 6. ✅ Plan & docs
- Create `plans/builtin-web-fetch/{01,02,03,04}.md`
- Add row to `docs/20-builtin-tools.md` Tool table
- Update `CLAUDE.md` Quick Start built-in tool list comment
