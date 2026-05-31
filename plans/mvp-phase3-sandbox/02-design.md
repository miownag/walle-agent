# Phase 3 — Sandbox Design

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│ @walle-agent/sandbox                                                   │
│                                                                        │
│  SandboxPlugin                                                         │
│   ├─► createSandbox(config)                                            │
│   │     ├─ "local"  → new LocalSandbox(config)                         │
│   │     └─ "docker" → new DockerSandbox(config)                        │
│   ├─► ctx.registerTool(buildShellTool(sandbox))                        │
│   └─► ctx.__sandbox = sandbox    (escape hatch)                        │
│                                                                        │
│  Sandbox interface                                                     │
│   ├─ LocalSandbox  → runner(cmd, args, opts)         (execa default)   │
│   └─ DockerSandbox → runner("docker", argv, opts)    (execa default)   │
│                                                                        │
│  shell tool — riskLevel:"high", tags:["builtin","shell"]               │
│   └─► sandbox.run({ cmd: "sh", args: ["-c", input.command], … })       │
│                                                                        │
│  Permissions slice (already landed in core)                            │
│   └─► requireApprovalFor.shell matches `tags:["shell"]`                │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

## Module layout

```
packages/sandbox/
├── package.json              peer-dep @walle-agent/core; dep execa ^9
├── tsconfig.json             extends ../../tsconfig.base.json
├── tsup.config.ts            external: ["@walle-agent/core","execa"]
├── src/
│   ├── index.ts              public exports
│   ├── sandbox-types.ts      Sandbox / SandboxCommand / SandboxResult /
│   │                         configs / SandboxRunner test seam
│   ├── local-sandbox.ts      LocalSandbox + fs helpers
│   ├── docker-sandbox.ts     DockerSandbox + argv builder
│   ├── shell-tool.ts         buildShellTool(sandbox) → Tool
│   └── sandbox-plugin.ts     SandboxPlugin
└── tests/                    runner-injection style; no real exec/docker
```

Mirrors `packages/mcp/` exactly (peer-dep + factory injection + tsup external).

## Key implementation choices

### Runner injection seam

```ts
export interface SandboxRunner {
  (file, args, options): Promise<{
    stdout, stderr, exitCode: number | undefined, timedOut?
  }>;
}
```

Default = `execa` (cast through `unknown`). Tests pass a `vi.fn()` and assert
on argv. Avoids `vi.mock("execa")` gymnastics and matches MCP's
`MCPClientFactory` precedent (`packages/mcp/src/mcp-client-manager.ts`).

### Shell parsing — deviation from spec

Spec shows `input.command.split(/\s+/)` inside the shell tool. That breaks
any non-trivial command (`echo "a b"`, pipes, redirects). We override:

```ts
sandbox.run({ cmd: "sh", args: ["-c", input.command], … })
```

The Sandbox interface stays cmd-vector based (the right primitive); the
shell wrapping is a tool-level concern. Documented in `docs/11-sandbox.md`.

### Timeout semantics

| Layer | Default |
|---|---|
| LocalSandbox | `command.timeoutMs ?? config.defaultTimeoutMs ?? 30_000` |
| DockerSandbox | `command.timeoutMs ?? 60_000` |

execa's `timeout: N` kills the child past `N` ms and reports
`timedOut: true`. We propagate that into `SandboxResult.timedOut`. **No throw
on timeout** — it's a normal result with `timedOut: true`. This is what
ticks the Phase-3 "工具超时正确处理" box.

### Failure semantics

| Situation | Result |
|---|---|
| Child exits non-zero | `{ exitCode: N, stdout, stderr }` (execa with `reject: false`) |
| Child killed by timeout | `{ timedOut: true, … }` |
| Runner throws (missing binary, etc.) | `{ exitCode: 1, stderr: error.message, durationMs }` |
| `allowedCommands` violation | `{ exitCode: 126, stderr: "Command not allowed: …" }` |

### Permissions integration

Zero new wiring. The `shell` tool carries `tags: ["builtin","shell"]` and
`riskLevel: "high"` + `requiresApproval: true`, so:

- `policy.requireApprovalFor.shell: true` → matches via tag.
- `policy.requireApprovalFor.riskLevel: ["high"]` → matches via riskLevel.
- `policy.mode: "deny-high-risk"` → blocks outright.
- `policy.denyTools: ["shell"]` → blocks by name.

All four work because Permissions already shipped.

### Coexistence with core's `bashTool`

Both tools end up registered when `SandboxPlugin` is installed alongside
default builtins. Same risk profile; LLM may pick either. Operators wanting
sandbox-only execution pass:

```ts
Agent.create({
  …,
  plugins: [new SandboxPlugin({ type: "local" })],
  useBuiltinTools: { excludeTools: ["bash"] },
});
```

No magical auto-exclusion in the plugin — keeps `Agent.create` deterministic.

### `ctx.__sandbox` escape hatch

Mirrors `ctx.__memoryManager` (memory-plugin.ts:91), `ctx.__skillRegistry`
(skills-plugin.ts), `ctx.__mcpManager` (mcp-plugin.ts:50). Lets a future
Code-Skill executor reach the Sandbox without importing this package.

## Public API surface

```ts
export { SandboxPlugin, LocalSandbox, DockerSandbox, buildShellTool };
export type {
  Sandbox, SandboxCommand, SandboxResult,
  SandboxPluginConfig, LocalSandboxConfig, DockerSandboxConfig,
  SandboxRunner, SandboxRunnerOptions, SandboxRunnerResult,
  ShellToolInput,
};
```

No re-exports through core; users import from `@walle-agent/sandbox`
directly (matches every other plugin package).
