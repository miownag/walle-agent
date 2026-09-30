import { randomUUID } from "node:crypto";
import type { ApprovalRequest } from "@walle-agent/core";
import type { ApprovalRequestDto, ProcessStep } from "../shared/contracts";

export type ApprovalDecision = "allow-once" | "always-allow" | "deny";

export type ApprovalBrokerEvent =
  | { type: "requested"; request: ApprovalRequestDto; step: ProcessStep }
  | {
      type: "resolved";
      request: ApprovalRequestDto;
      decision: ApprovalDecision;
    };

interface PendingApproval {
  request: ApprovalRequestDto;
  resolve: (allowed: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ApprovalBroker {
  private pending = new Map<string, PendingApproval>();

  constructor(
    private readonly emit: (event: ApprovalBrokerEvent) => void,
    private readonly alwaysAllow: (
      request: ApprovalRequestDto,
    ) => Promise<boolean>,
  ) {}

  request(
    threadId: string,
    runId: string,
    core: ApprovalRequest,
  ): Promise<boolean> {
    const approvalId = randomUUID();
    const request: ApprovalRequestDto = {
      approvalId,
      threadId,
      runId,
      toolCallId: core.call.id,
      toolName: core.tool.name,
      description: core.description,
      riskLevel: core.riskLevel,
      tags: core.tool.tags ?? [],
      input: core.call.arguments,
      createdAt: new Date().toISOString(),
    };
    const step: ProcessStep = {
      id: randomUUID(),
      type: "approval",
      title: `Approval required · ${core.tool.name}`,
      content: core.description,
      status: "pending",
      startedAt: request.createdAt,
      toolName: core.tool.name,
      toolCallId: core.call.id,
      input: core.call.arguments,
      approvalId,
      riskLevel: core.riskLevel,
    };
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(approvalId);
        if (!pending) return;
        this.pending.delete(approvalId);
        this.emit({ type: "resolved", request, decision: "deny" });
        resolve(false);
      }, 30 * 60_000);
      timer.unref?.();
      this.pending.set(approvalId, { request, resolve, timer });
      this.emit({ type: "requested", request, step });
    });
  }

  async resolve(approvalId: string, decision: ApprovalDecision): Promise<void> {
    const pending = this.pending.get(approvalId);
    if (!pending) throw new Error(`Unknown or expired approval: ${approvalId}`);
    this.pending.delete(approvalId);
    clearTimeout(pending.timer);
    let effectiveDecision = decision;
    if (decision === "always-allow") {
      try {
        if (!(await this.alwaysAllow(pending.request)))
          effectiveDecision = "allow-once";
      } catch (error) {
        this.emit({
          type: "resolved",
          request: pending.request,
          decision: "allow-once",
        });
        pending.resolve(true);
        throw error;
      }
    }
    this.emit({
      type: "resolved",
      request: pending.request,
      decision: effectiveDecision,
    });
    pending.resolve(effectiveDecision !== "deny");
  }

  cancelThread(threadId: string): void {
    for (const [approvalId, pending] of this.pending) {
      if (pending.request.threadId !== threadId) continue;
      this.pending.delete(approvalId);
      clearTimeout(pending.timer);
      this.emit({
        type: "resolved",
        request: pending.request,
        decision: "deny",
      });
      pending.resolve(false);
    }
  }

  cancelAll(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      this.emit({
        type: "resolved",
        request: pending.request,
        decision: "deny",
      });
      pending.resolve(false);
    }
    this.pending.clear();
  }
}
