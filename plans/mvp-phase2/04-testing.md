# Phase 2 — Memory Testing Plan

## Test Strategy

Two layers:

1. **Unit tests** — exercise each class (`SessionLog`, `ToolResultVault`, `FileMemoryStore`, `MemoryManager`, `similarity`) with a tmp dir per test (`os.tmpdir()` + `fs.mkdtemp`). No network, no real LLM.
2. **Integration tests** — full `Agent.create(...)` pipeline with the existing `MockProvider` from `packages/core/tests/mock-provider.ts`. Assert end-to-end behaviour (JSONL on disk, prompt contents, rehydration rules).

All tests run under `vitest` via `pnpm test`. `vitest.config.ts` already globs `packages/**`.

---

## Unit tests

### `packages/memory/tests/session-log.test.ts`
- Appends `messages.jsonl` line-by-line; `readAll` parses them back in insertion order.
- `appendMessage` + `appendRun` concurrently (mixed order) still produce a valid JSONL.
- `lastCancelledRunId` returns:
  - `undefined` when no runs.
  - the id when the most-recent run has `status="user-cancelled"`.
  - `undefined` when the most-recent is `completed` even if an earlier one was cancelled.
- Resilient to a malformed trailing line (logs + skips).

### `packages/memory/tests/tool-result-vault.test.ts`
- `evict` creates `<id>.txt` with the full content and `<id>.meta.json` with size/preview/evictedAt.
- Preview composition: content with < head+tail lines returns the whole thing; with more lines returns `head` + `"... [N lines truncated] ..."` + `tail`.
- `read(id)` returns the exact bytes written.
- `formatSummary` yields a string containing both the path and the preview, prefixed with the canonical "Tool result too long." phrase.

### `packages/memory/tests/file-memory-store.test.ts`
- put → get → list round-trip survives store re-instantiation (persistence).
- update mutates in place; delete removes and rewrites the JSONL without the removed id.
- search scoring:
  - items with more overlapping tokens rank higher.
  - `scope` / `types` / `userId` filters are honoured.
  - empty query returns first-N by insertion order (or tag-only score if tags present).

### `packages/memory/tests/memory-manager.test.ts`
- `remember` with a unique content → creates an item.
- `remember` with near-duplicate (Jaccard > 0.8) content → merges; confidence = `max(existing, incoming)`; `updatedAt` set.
- `retrieve` returns items ordered by score, limited to `topK`.
- `forget` removes from disk.

### `packages/memory/tests/similarity.test.ts`
- Identical strings → 1.
- Disjoint word-sets → 0.
- Symmetric (`jaccard(a,b) === jaccard(b,a)`).
- Ignores case + extra whitespace.

---

## Integration tests (`packages/memory/tests/memory-plugin.integration.test.ts`)

All use a tmp `rootDir` and a shared `MockProvider` instance whose canned responses are sequenced per scenario.

### Scenario A — session round-trip
1. `agent.run("Remember that I prefer TypeScript", { sessionId: "s1" })`
2. New agent instance, same `rootDir`, same `sessionId`.
3. `agent.run("What language do I prefer?", { sessionId: "s1" })`
4. Assert the LLM request in step 3 contains the prior user + assistant messages as `conversationHistory` ahead of the new user message.

### Scenario B — tool-result eviction
1. Register a mock `get_large_log` tool that returns a 12KB string.
2. Configure `MemoryPlugin({ largeToolResults: { thresholdChars: 4000 } })` (lower threshold is fine for the test; default is 20000).
3. Run #1: user asks for the log; mock provider emits a tool call; tool returns the huge string; run finishes.
4. On disk: `messages.jsonl` contains a stub envelope for that tool message (not the full 12KB); `large-tool-results/<id>.txt` contains the full payload.
5. Run #2 with same sessionId: assert the rehydrated tool message in the LLM request is the summary string (starts with "Tool result too long." and contains the file path).
6. Assert `large-tool-results/<id>.meta.json` has the correct size/preview.

### Scenario C — cancel-and-resume
1. Run #1 starts; after the oversized tool call completes, the generator is aborted via `AbortController` before the next LLM call. `runs.jsonl` records `status="user-cancelled"`.
2. Run #2 with same sessionId: assert the tool message is rehydrated to the **full content** (not summarized) because it belongs to a cancelled run.
3. Run #2 completes. Run #3: assert the tool message for run #1 is now summarized (cancel-protection only applies to the single cancelled run).

### Scenario D — LTM retrieval
1. Run #1: agent invokes `remember` tool with `{ content: "User prefers pnpm over npm", tags: ["package-manager"] }`.
2. Run #2: user asks "which package manager should I use?"; assert `collect_context` surfaces the stored item and the LLM request's system prompt includes the content.

### Scenario E — dedup
1. Two `remember` calls with near-identical content; assert memories.jsonl ends with a single item whose `updatedAt` is set and `confidence` equals `max`.

---

## Build / type verification

```bash
pnpm -r build
  ✓ @walle-agent/core   — ESM + CJS + DTS
  ✓ @walle-agent/openai
  ✓ @walle-agent/anthropic
  ✓ @walle-agent/memory — new
```

## Manual regression

```bash
# Existing examples keep working
pnpm basic
pnpm stream

# New memory example
pnpm --filter walle-agent-examples run memory
```

Expected:
1. The `memory` example prints two runs. The second run's final answer references the preference stored in the first.
2. `./.walle/sessions/<sid>/messages.jsonl` is readable and contains both runs' messages.
3. `./.walle/memory/memories.jsonl` contains the remembered preference.

## Regression matrix

| Scenario | Status |
|----------|--------|
| Phase 1 integration tests (non-streaming / streaming / tool loop) keep passing | must pass |
| `collect_messages` event fires even when no plugin registers it (no-op) | must pass |
| Running without `sessionId` works and does not create session files | must pass |
| `MemoryPlugin` disabled sub-features (sessions/largeToolResults/longTerm) → plugin is still installable, only the disabled paths are skipped | must pass |
| Disposing an agent flushes pending writes | must pass |
