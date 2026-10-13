# Verification

Runtime tests cover active-run steering, tool-message pairing and final-response follow-ups. Desktop tests cover ordered queues, cancellation, removal, persistence, and composer submission. Required checks: pnpm build, pnpm test, pnpm typecheck.

Validated: pnpm build, pnpm test (540 SDK tests and 166 desktop tests), pnpm typecheck, and git diff --check. Native UI confirms the check icon and persisted queue after a development restart.
