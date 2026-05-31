# Phase 3 — Permissions Requirements

## Goal

Land the **Permissions** slice of Phase 3: gate every tool call through a
typed `PermissionPolicy` that supports allow/deny lists, per-risk-level
approval, tag-based approval (file-write / network / shell), and an async
`approvalHandler` callback for human-in-the-loop confirmation.

Sandbox is tracked separately — this branch only covers Permissions.

The Permission types and `Tool.riskLevel` / `Tool.requiresApproval` fields
were stubbed in earlier phases but never enforced. This slice rewrites the
policy shape to match `docs/13-permissions.md`, wires it into the runtime,
and starts honouring tool declarations.

---

## Must-Haves

1. **New module `packages/core/src/permissions.ts`** holding:
   - `PermissionPolicy`, `ApprovalRequest`, `PermissionDecision` types.
   - `checkToolPermission(tool, call, policy): Promise<PermissionDecision>`.

2. **Policy shape** matches `docs/13-permissions.md` exactly:
   - `mode: "auto" | "ask" | "deny-high-risk"` (default `"auto"`).
   - `allowTools: string[]`, `denyTools: string[]` — `denyTools` wins.
   - `requireApprovalFor: { riskLevel?, toolNames?, fileWrite?, network?, shell? }`
     as the master switch for approval gating.
   - `approvalHandler?: (req: ApprovalRequest) => Promise<boolean>` async callback.

3. **Runtime wiring**: `agent-runtime.ts` calls `checkToolPermission` before
   every tool execution; if the decision is `{ allowed: false }` the
   `ToolCallRecord.status` is `"denied"` (existing path, no change at the
   call site).

4. **Built-in tags**: `writeFileTool` and `editFileTool` carry `"file-write"`
   tag so `requireApprovalFor.fileWrite` matches them. `bashTool` already has
   `"shell"`.

5. **Faulty handler safety**: a throwing `approvalHandler` is treated as deny
   and logged — never crashes the run.

6. **Stay in core**: no separate `@walle-agent/permissions` package. Spec
   allows it; the surface is small (~150 LOC) and tightly coupled to
   `Tool` + `agent-runtime`.

---

## Acceptance Criteria

- [x] `denyTools` denies even when `mode` would otherwise allow.
- [x] `allowTools` short-circuits to allow even for high-risk tools.
- [x] `mode: "deny-high-risk"` blocks `tool.riskLevel === "high"`.
- [x] `requireApprovalFor.riskLevel` triggers `approvalHandler`; result honoured.
- [x] `requireApprovalFor.toolNames` triggers approval by name.
- [x] `requireApprovalFor.{shell,fileWrite,network}` match by tag.
- [x] `tool.requiresApproval: true` triggers approval **only when**
      `requireApprovalFor` is set (master-switch design, follows spec literal).
- [x] `mode: "ask"` + needs approval + no handler → deny with clear reason.
- [x] `mode: "auto"` + needs approval + no handler → silently allow.
- [x] Handler that throws → deny + `console.error` log.
- [x] `permissions: undefined` → unchanged behavior (allow all).
- [x] Phase-3 roadmap acceptance "高风险工具触发权限检查" ticked.

---

## Non-Goals

- No telemetry / Trace integration of approval decisions (deferred to Phase 5).
- No CLI / interactive prompt utility shipped — examples in spec only.
- No Sandbox integration — tracked in a separate branch.
- No persistence of approval decisions across runs (each call is checked fresh).
