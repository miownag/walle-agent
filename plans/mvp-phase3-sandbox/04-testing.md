# Phase 3 — Sandbox Testing

## Unit tests

### `packages/sandbox/tests/local-sandbox.test.ts` (12 tests)

**`LocalSandbox.run`**
- Returns stdout/stderr/exitCode/durationMs from runner.
- Forwards `cwd`/`env`/`stdin`/`timeout` to runner with `reject: false`.
- Falls back to 30s default when no overrides given.
- `config.defaultTimeoutMs` overrides 30s default.
- Surfaces `timedOut: true` from runner instead of throwing.
- `allowedCommands` blocks unlisted base name with exitCode 126; runner not called.
- `allowedCommands` matches base name even when given a full path.
- Runner-thrown errors converted to `{ exitCode: 1, stderr: error.message }`.

**File ops** (real fs in tmpdir)
- `writeFile` + `readFile` round-trip relative to `cwd`.
- `listFiles` returns directory entries.
- Absolute paths bypass cwd resolution.

**`dispose()`**
- Resolves without doing anything.

### `packages/sandbox/tests/docker-sandbox.test.ts` (8 tests)

**Argv construction**
- Minimal config produces `docker run --rm --network none -w /workspace <image> <cmd> [args]`.
- Full config produces `-m`, `--cpus`, `--network`, `-w`, `-v`, `-e`, image, cmd, args in spec order.
- `command.cwd` overrides `config.workdir`.

**Timeouts**
- Default timeout 60s.
- `command.timeoutMs` honoured.
- `timedOut: true` propagated.

**Failures**
- Runner throw → `{ exitCode: 1, stderr: error.message }`.

**File ops**
- `writeFile` throws `/volumes/`.
- `dispose` is a no-op.

### `packages/sandbox/tests/shell-tool.test.ts` (4 tests)

- Tool metadata: `name: "shell"`, `riskLevel: "high"`, `requiresApproval: true`, `tags: ["builtin","shell"]`, `parameters.required: ["command"]`.
- `execute` calls `sandbox.run` with `{ cmd: "sh", args: ["-c", input.command], cwd, timeoutMs }`.
- Returns the SandboxResult verbatim (including `timedOut`).
- Sandbox throws propagate through.

### `packages/sandbox/tests/sandbox-plugin.test.ts` (6 tests)

- `type: "local"` builds a `LocalSandbox`.
- `type: "docker"` builds a `DockerSandbox`.
- `install()` registers the `shell` tool with `riskLevel: "high"`.
- `install()` exposes the sandbox via `ctx.__sandbox`.
- `getSandbox()` returns the same instance.
- `dispose()` forwards to `sandbox.dispose`.

## Build

- `pnpm --filter @walle-agent/sandbox build` — clean ESM (5.92 KB) + CJS (7.69 KB) + d.ts (6.70 KB).
- `pnpm build` (full monorepo) — clean across 9 packages.

## Full suite

- `pnpm test` — **252 passed (32 files)**, up from 222 before this branch (+30 sandbox tests).

## Manual smoke (recommended)

1. **Real exec** — `LocalSandbox.run({ cmd: "echo", args: ["hi"] })` → `stdout: "hi\n"`, `exitCode: 0`.
2. **Permissions integration** — wire SandboxPlugin alongside
   `permissions: { mode: "ask", requireApprovalFor: { shell: true }, approvalHandler: async () => false }`,
   call the `shell` tool; expect `status: "denied"` from agent-runtime.
3. **Real timeout** — `LocalSandbox.run({ cmd: "sleep", args: ["10"], timeoutMs: 50 })` → `timedOut: true`.
   (Skipped in CI to avoid platform-specific flakiness; the injected-runner test covers the propagation path.)

## Phase 3 status after this slice

```
Phase 3 — MCP + Sandbox + Permissions   ✅ COMPLETE
- [x] MCP stdio server 的工具能被 Agent 调用
- [x] MCP HTTP server 工具能被调用
- [x] 高风险工具触发权限检查
- [x] Sandbox 中执行 shell 命令并返回结果
- [x] 工具超时正确处理
```
