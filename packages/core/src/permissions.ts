/**
 * Permissions — gate tool calls behind risk-level checks, allow/deny lists,
 * and an optional async approval handler. Mirrors `docs/13-permissions.md`.
 *
 * Wired into `agent-runtime.ts` at the tool-execution boundary; if a
 * permission check returns `{ allowed: false }` the runtime emits a tool
 * record with `status: "denied"` instead of executing the tool.
 */

import type { ModelToolCall } from "./message.js";
import type { Tool } from "./tool.js";

// ─── Public types ──────────────────────────────────────────────────

export interface PermissionPolicy {
  /**
   * Global mode.
   *  - "auto": permissive default; only the explicit deny/approval rules apply.
   *  - "ask": requireApprovalFor matches must hit `approvalHandler` or be denied.
   *  - "deny-high-risk": tools with `riskLevel === "high"` are denied outright.
   * Default: "auto".
   */
  mode?: "auto" | "ask" | "deny-high-risk";

  /** Tools always allowed; bypass mode + approval checks. */
  allowTools?: string[];

  /** Tools always denied. Highest priority — even allowTools can't override. */
  denyTools?: string[];

  /**
   * Master switch for approval gating. Approval requirements only apply when
   * this object is set; absence means "no approval ever required". This is
   * deliberate — `tool.requiresApproval` alone is not enough to trigger the
   * handler, you must opt in via this field.
   */
  requireApprovalFor?: {
    riskLevel?: Array<"medium" | "high">;
    toolNames?: string[];
    /** Triggers when tool has tag "file-write". */
    fileWrite?: boolean;
    /** Triggers when tool has tag "network". */
    network?: boolean;
    /** Triggers when tool has tag "shell". */
    shell?: boolean;
  };

  /**
   * Async callback invoked when a tool call needs approval. Returns true to
   * allow, false to deny. If the handler throws, the call is denied + logged.
   */
  approvalHandler?: (request: ApprovalRequest) => Promise<boolean>;
}

export interface ApprovalRequest {
  tool: Tool;
  call: ModelToolCall;
  riskLevel: "low" | "medium" | "high";
  /** Pre-formatted human-readable description of the call. */
  description: string;
}

export interface PermissionDecision {
  allowed: boolean;
  reason?: string;
}

// ─── checkToolPermission ───────────────────────────────────────────

const DESCRIPTION_MAX_LEN = 1024;

/**
 * Decide whether a tool call should run under the given policy.
 *
 * Algorithm (matches `docs/13-permissions.md`):
 *   1. denyTools wins — denied even if allowTools also lists it.
 *   2. allowTools — short-circuit allow.
 *   3. mode === "deny-high-risk" + tool.riskLevel === "high" → deny.
 *   4. If `requireApprovalFor` matches → consult `approvalHandler`:
 *      - no handler + mode "ask" → deny (with reason "no handler").
 *      - no handler + mode "auto" / "deny-high-risk" → silently allow.
 *      - handler approves → allow.
 *      - handler denies / throws → deny.
 *   5. Otherwise → allow.
 */
export async function checkToolPermission(
  tool: Tool,
  call: ModelToolCall,
  policy: PermissionPolicy,
): Promise<PermissionDecision> {
  // 1. denyTools — highest priority
  if (policy.denyTools?.includes(tool.name)) {
    return { allowed: false, reason: "Tool is denied by policy" };
  }

  // 2. allowTools — explicit allow short-circuits
  if (policy.allowTools?.includes(tool.name)) {
    return { allowed: true };
  }

  // 3. deny-high-risk mode
  const mode = policy.mode ?? "auto";
  if (mode === "deny-high-risk" && tool.riskLevel === "high") {
    return { allowed: false, reason: "High-risk tool denied by policy" };
  }

  // 4. Approval gate
  if (checkNeedsApproval(tool, policy)) {
    if (!policy.approvalHandler) {
      if (mode === "ask") {
        return {
          allowed: false,
          reason: "Approval required but no handler configured",
        };
      }
      // auto / deny-high-risk: silently allow (only "ask" forces strictness).
      return { allowed: true };
    }

    let approved: boolean;
    try {
      approved = await policy.approvalHandler({
        tool,
        call,
        riskLevel: tool.riskLevel ?? "low",
        description: describeCall(tool, call),
      });
    } catch (err) {
      // Faulty handler → deny + log; never crash the run.
      // eslint-disable-next-line no-console
      console.error(
        `[permissions] approvalHandler threw for tool '${tool.name}':`,
        err,
      );
      return { allowed: false, reason: "Approval handler error" };
    }

    return approved
      ? { allowed: true }
      : { allowed: false, reason: "Approval denied" };
  }

  // 5. Default allow
  return { allowed: true };
}

/**
 * Return true iff the call matches any rule in `policy.requireApprovalFor`.
 * If `requireApprovalFor` is unset, returns false unconditionally — even when
 * `tool.requiresApproval` is true. The master switch is deliberate.
 */
function checkNeedsApproval(tool: Tool, policy: PermissionPolicy): boolean {
  const req = policy.requireApprovalFor;
  if (!req) return false;

  // Tool's own opt-in.
  if (tool.requiresApproval) return true;

  // Risk-level match.
  if (req.riskLevel && tool.riskLevel) {
    if (req.riskLevel.includes(tool.riskLevel as "medium" | "high")) return true;
  }

  // Explicit tool-name list.
  if (req.toolNames?.includes(tool.name)) return true;

  // Tag-based matches.
  const tags = tool.tags ?? [];
  if (req.fileWrite && tags.includes("file-write")) return true;
  if (req.network && tags.includes("network")) return true;
  if (req.shell && tags.includes("shell")) return true;

  return false;
}

function describeCall(tool: Tool, call: ModelToolCall): string {
  let args: string;
  try {
    args = JSON.stringify(call.arguments);
  } catch {
    args = "[unserialisable]";
  }
  if (args.length > DESCRIPTION_MAX_LEN) {
    args = args.slice(0, DESCRIPTION_MAX_LEN) + "…";
  }
  return `Tool "${tool.name}" wants to execute with args: ${args}`;
}
