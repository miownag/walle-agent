# Phase 3 — Permissions Tasks

## Done

- [x] `packages/core/src/permissions.ts` — types + `checkToolPermission` + `checkNeedsApproval` + `describeCall`.
- [x] `packages/core/src/agent-config.ts` — drop inline `PermissionPolicy` / `PermissionRule` / `PermissionDecision`; re-export from `./permissions.js`.
- [x] `packages/core/src/agent-runtime.ts` — replace inline `checkPermission` body with `checkToolPermission` call; import paths updated.
- [x] `packages/core/src/index.ts` — drop `PermissionRule`, add `ApprovalRequest` + `checkToolPermission`.
- [x] `packages/core/src/builtin-tools/filesystem-tools.ts` — `writeFileTool` + `editFileTool` gain `"file-write"` tag.
- [x] `packages/core/tests/permissions.test.ts` — 18 tests covering the full matrix.
- [x] `packages/core/tests/integration.test.ts` — "permission denial" test migrated from `rules`-shape to `denyTools`.
- [x] `docs/18-roadmap.md` — Phase 3 acceptance "高风险工具触发权限检查" ticked.
- [x] `plans/mvp-phase3-permissions/{01-requirements,02-design,03-tasks,04-testing}.md` long-term record created.

## Out of scope (deferred)

- Sandbox integration (separate branch).
- Telemetry of approval decisions (Phase 5 with Trace).
- CLI / readline approval helpers shipped as utilities.
- Persistence of "approve once / approve always" decisions.
