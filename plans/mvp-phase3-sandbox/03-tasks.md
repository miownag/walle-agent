# Phase 3 — Sandbox Tasks

## Done

- [x] `packages/sandbox/package.json` — peer-dep `@walle-agent/core`, dep `execa ^9.5.0`.
- [x] `packages/sandbox/tsconfig.json` — extends base.
- [x] `packages/sandbox/tsup.config.ts` — externals: core + execa.
- [x] `packages/sandbox/src/sandbox-types.ts` — types + `SandboxRunner` test seam.
- [x] `packages/sandbox/src/local-sandbox.ts` — LocalSandbox with allowedCommands + fs helpers.
- [x] `packages/sandbox/src/docker-sandbox.ts` — DockerSandbox + argv builder; writeFile throws.
- [x] `packages/sandbox/src/shell-tool.ts` — `buildShellTool` wraps any Sandbox; `sh -c` semantics.
- [x] `packages/sandbox/src/sandbox-plugin.ts` — registers tool, exposes `ctx.__sandbox`.
- [x] `packages/sandbox/src/index.ts` — public exports.
- [x] `packages/sandbox/tests/local-sandbox.test.ts` — 12 tests.
- [x] `packages/sandbox/tests/docker-sandbox.test.ts` — 8 tests.
- [x] `packages/sandbox/tests/shell-tool.test.ts` — 4 tests.
- [x] `packages/sandbox/tests/sandbox-plugin.test.ts` — 6 tests.
- [x] `docs/18-roadmap.md` — Phase 3 acceptance: "Sandbox 中执行 shell 命令并返回结果" + "工具超时正确处理" ticked.
- [x] `docs/11-sandbox.md` — minor sync notes (`sh -c` deviation, runner seam, coexistence).
- [x] `plans/mvp-phase3-sandbox/{01-requirements,02-design,03-tasks,04-testing}.md`.

## Out of scope (deferred)

- `docker cp`-based file I/O on DockerSandbox (volumes cover MVP needs).
- Persistent / exec-into-existing-container support (Phase 6 Code-Skill executor).
- Real docker integration tests (CI flakiness; argv is verified via injected runner).
- Network whitelist / DNS sandbox controls (Phase 6).
- Stream output (current API is buffered stdout/stderr; Phase 4+ if needed).
