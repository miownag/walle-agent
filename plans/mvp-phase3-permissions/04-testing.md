# Phase 3 — Permissions Testing

## Unit tests

### `packages/core/tests/permissions.test.ts` (18 tests, all passing)

Matrix:

**denyTools / allowTools**
- `denyTools` blocks even when `mode` would otherwise allow.
- `denyTools` beats `allowTools` when both match.
- `allowTools` short-circuits to allow even for high-risk + ask mode + denying handler.

**`mode: "deny-high-risk"`**
- Blocks `tool.riskLevel === "high"`.
- Allows medium and low risk tools.

**`requireApprovalFor`**
- `riskLevel` match triggers `approvalHandler`; approve → allow (verifies `ApprovalRequest` shape including `description`).
- `riskLevel` match — handler denies → deny.
- `toolNames` match triggers approval.
- `shell` tag match.
- `fileWrite` tag match.
- `network` tag match.
- `tool.requiresApproval` triggers when `requireApprovalFor` is set (even if empty `{}`).
- `tool.requiresApproval` IGNORED when `requireApprovalFor` is unset (master-switch design).

**Missing approvalHandler**
- `ask` mode + needs approval + no handler → deny with reason "no handler configured".
- `auto` mode + needs approval + no handler → silent allow.

**Handler errors**
- Throwing handler is treated as deny + logged via `console.error`.

**Default behaviour**
- Empty policy `{}` allows everything (low/medium/high).
- Description truncates very long argument payloads (5000-char input → output < 5000 chars, ends with "…").

## Integration regression

### `packages/core/tests/integration.test.ts`

The "permission denial" test was already exercising the deny path; only the
policy shape changed (`rules: [{tool, action: "deny"}]` → `denyTools: ["dangerous_tool"]`).
The assertion `result.toolCalls[0].status === "denied"` still holds.

## Build

- `pnpm --filter @walle-agent/core build` — clean ESM + CJS + d.ts (`32.66 KB` types).
- `pnpm build` — full monorepo clean.

## Full suite

- `pnpm test` — **222 passed (28 files)**, up from 204 before this branch
  (+18 from `permissions.test.ts`).

## Manual smoke (recommended)

```ts
const handler = vi.fn(async () => false);
const agent = await Agent.create({
  name: "secure",
  model: provider,
  permissions: {
    mode: "ask",
    requireApprovalFor: { riskLevel: ["high"] },
    approvalHandler: handler,
  },
});
const result = await agent.run("run `ls`");
// Expected: bash tool call has status: "denied", reason: "Approval denied".
// handler called with description containing the bash arg shape.
```
