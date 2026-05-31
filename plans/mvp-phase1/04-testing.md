# MVP Phase 1 — Testing

## Test Strategy

Unit tests + integration tests using a MockProvider (no real API calls needed).

## Test Results

```
✓ packages/core/tests/event-bus.test.ts (4 tests)
✓ packages/core/tests/tool-registry.test.ts (6 tests)
✓ packages/core/tests/hook-manager.test.ts (5 tests)
✓ packages/core/tests/middleware.test.ts (4 tests)
✓ packages/core/tests/stream.test.ts (4 tests)
✓ packages/core/tests/integration.test.ts (10 tests)

Test Files  6 passed (6)
     Tests  33 passed (33)
```

## Build Verification

```
pnpm -r build
  ✓ @walle-agent/core — ESM + CJS + DTS
  ✓ @walle-agent/openai — ESM + CJS + DTS
  ✓ @walle-agent/anthropic — ESM + CJS + DTS
```

## Integration Test Coverage

| Scenario | Status |
|----------|--------|
| Non-streaming run | ✓ |
| Streaming run + events | ✓ |
| Tool call loop (call → execute → feed back → final) | ✓ |
| System prompt injection | ✓ |
| Plugin install/dispose | ✓ |
| Hooks firing | ✓ |
| Tool not found (graceful error) | ✓ |
| maxTurns limit | ✓ |
| Permission deny | ✓ |
| Plugin registering tools | ✓ |

## Manual Testing

To test with real API keys:
```bash
OPENAI_API_KEY=sk-xxx pnpm --filter examples run basic
OPENAI_API_KEY=sk-xxx pnpm --filter examples run stream
```
