# Phase 3 — Sandbox Requirements

## Goal

Land the **Sandbox** slice of Phase 3: a `@walle-agent/sandbox` package that
provides isolated shell execution via two backends — `LocalSandbox`
(execa-based) and `DockerSandbox` (docker CLI via execa) — and registers a
high-risk `shell` tool gated by the Permissions slice.

Together with the just-shipped Permissions slice, this completes Phase 3:

- [x] 高风险工具触发权限检查 (Permissions, prior slice)
- [x] Sandbox 中执行 shell 命令并返回结果
- [x] 工具超时正确处理

## Must-Haves

1. **New package `@walle-agent/sandbox`** with peer-dep on
   `@walle-agent/core` and a hard-dep on `execa` ^9.

2. **`Sandbox` interface** exactly as in `docs/11-sandbox.md`:
   `name`, `run(SandboxCommand)`, optional `writeFile`/`readFile`/`listFiles`
   /`dispose`. `SandboxCommand` carries `cmd/args/cwd/env/timeoutMs/stdin`;
   `SandboxResult` carries `stdout/stderr/exitCode/durationMs/timedOut`.

3. **`LocalSandbox`** — uses execa via an injectable `runner` seam:
   - Honours `command.timeoutMs ?? config.defaultTimeoutMs ?? 30_000`.
   - Returns `{ timedOut: true }` instead of throwing when execa kills the child.
   - Optional `allowedCommands` base-name allowlist (exit 126 when violated).
   - `writeFile`/`readFile`/`listFiles` resolve relative paths against `cwd`.

4. **`DockerSandbox`** — builds `docker run --rm` argv per spec
   (memory, cpus, network, workdir, volumes, env), default `--network none`,
   default workdir `/workspace`, default timeout 60s. `writeFile` throws
   `"Not implemented: use volumes for file access"` (spec literal).

5. **`SandboxPlugin`** — installs the `shell` tool and exposes the sandbox
   on `ctx.__sandbox` (matches `__memoryManager` / `__skillRegistry` /
   `__mcpManager` precedent).

6. **`shell` tool** — `riskLevel: "high"`, `requiresApproval: true`,
   `tags: ["builtin","shell"]`. Wraps the user's command line with
   `sh -c "..."` so quoting/pipes/redirects work. Coexists with the built-in
   `bashTool`; users disable it via `useBuiltinTools: { excludeTools: ["bash"] }`
   if they want sandbox-only execution.

7. **Test seam** — every config takes an optional `runner` field of type
   `SandboxRunner`; tests inject a fake runner instead of mocking execa.

## Acceptance Criteria

- [x] LocalSandbox runs `echo hi` end-to-end (stdout = "hi", exitCode 0).
- [x] LocalSandbox honours `timeoutMs` and surfaces `timedOut: true`.
- [x] LocalSandbox `allowedCommands` blocks unlisted base names (exit 126).
- [x] DockerSandbox argv matches spec under all flag combinations.
- [x] DockerSandbox writeFile throws the spec'd message.
- [x] `shell` tool dispatches to `sandbox.run({ cmd: "sh", args: ["-c", line] })`.
- [x] SandboxPlugin registers the tool, exposes `ctx.__sandbox`, and
      `dispose()` forwards to the sandbox.
- [x] Permissions slice's `requireApprovalFor.shell` matches the new tool's
      `tags` automatically (no extra wiring needed).

## Non-Goals

- DockerSandbox file I/O via `docker cp` (deferred; volume mounts cover
  the MVP use case).
- Persistent containers / exec-into-existing-container (deferred to Phase 6
  Code-Skill executor).
- Real docker integration tests (out of scope for the unit-test boundary;
  argv is verified via injected runner).
- Resource quotas beyond `-m` / `--cpus` (out of scope).
