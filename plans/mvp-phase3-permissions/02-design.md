# Phase 3 — Permissions Design

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│ @walle-agent/core (no new package)                                     │
│                                                                        │
│  AgentRuntime.executeTool(call)                                        │
│   └─► checkPermission(tool, call)                                      │
│        └─► checkToolPermission(tool, call, policy)  ← permissions.ts   │
│             1. denyTools wins                                          │
│             2. allowTools short-circuit                                │
│             3. mode="deny-high-risk" + risk="high" → deny              │
│             4. checkNeedsApproval(tool, policy)                        │
│                ├─ no requireApprovalFor → no approval needed           │
│                ├─ tool.requiresApproval → needs                        │
│                ├─ riskLevel match    → needs                           │
│                ├─ toolNames match    → needs                           │
│                └─ shell/fileWrite/network tag → needs                  │
│                                                                        │
│             5. approval needed:                                        │
│                ├─ no handler + ask  → deny ("no handler")              │
│                ├─ no handler + auto → allow (silent)                   │
│                ├─ handler approves  → allow                            │
│                ├─ handler denies    → deny ("Approval denied")         │
│                └─ handler throws    → deny ("Approval handler error") │
│                                                                        │
│  Built-in tools' tags:                                                 │
│    bashTool       → ["builtin","shell"]                                │
│    writeFileTool  → ["builtin","filesystem","file-write"]              │
│    editFileTool   → ["builtin","filesystem","file-write"]              │
└────────────────────────────────────────────────────────────────────────┘
```

## Module layout

```
packages/core/src/
  permissions.ts                  # NEW: types + checkToolPermission
  agent-config.ts                 # re-exports types from permissions.ts
  agent-runtime.ts                # checkPermission() delegates to checkToolPermission
  builtin-tools/
    filesystem-tools.ts           # writeFile/editFile gain "file-write" tag
```

## Public API surface

```ts
// New
export type { PermissionPolicy, PermissionDecision, ApprovalRequest } from "./permissions.js";
export { checkToolPermission } from "./permissions.js";

// Removed (was rules-based, never used externally)
- export type { PermissionRule } from "./agent-config.js";
```

`PermissionPolicy` lives directly on `AgentConfig.permissions` (unchanged
ergonomics, richer shape).

## Decision precedence (single source of truth)

```
denyTools  >  allowTools  >  deny-high-risk mode  >  approval gate  >  default allow
```

If a tool name is in both `denyTools` and `allowTools`, deny wins. This is
documented + tested.

## Master-switch design

The `requireApprovalFor` field is **required** for any approval to trigger,
including `tool.requiresApproval: true`. Rationale:

- Tools declare risk hints that the agent operator decides whether to honour.
- An MVP without `requireApprovalFor` should "just work" without surprise
  approval prompts, even though built-ins like `bashTool` carry
  `requiresApproval: true`.
- Operators opt in explicitly via `requireApprovalFor: {}`.

## Failure semantics

| Situation | Decision |
|---|---|
| `permissions` is `undefined` | allow (skip the entire check) |
| `approvalHandler` resolves `false` | deny with reason `"Approval denied"` |
| `approvalHandler` resolves `true` | allow |
| `approvalHandler` throws / rejects | deny with reason `"Approval handler error"`, `console.error` |
| `mode: "ask"` + no handler + needs approval | deny with reason `"Approval required but no handler configured"` |
| `mode: "auto"` + no handler + needs approval | allow (silent) — operator chose `auto` knowingly |
| `mode: "deny-high-risk"` + handler exists + high-risk | deny BEFORE consulting handler (mode beats approval) |

## Description format for `ApprovalRequest`

```
Tool "${tool.name}" wants to execute with args: ${JSON.stringify(args)}
```

Truncated at 1024 chars with "…" suffix. Unserialisable args fall back to
`"[unserialisable]"`. Keeps the handler payload small while remaining useful
for logging and CLI prompts.
