import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@walle-agent/core";
import { ApprovalBroker, type ApprovalBrokerEvent } from "../approval-broker";

function request(): ApprovalRequest {
  return {
    tool: {
      name: "shell",
      description: "Run a command",
      parameters: { type: "object" },
      riskLevel: "high",
      tags: ["shell"],
      async execute() {
        return {};
      },
    },
    call: { id: "call-1", name: "shell", arguments: { command: "pwd" } },
    riskLevel: "high",
    description: "Run pwd",
  };
}

describe("ApprovalBroker", () => {
  it("settles the tool as allow-once when persisting always-allow fails", async () => {
    const events: ApprovalBrokerEvent[] = [];
    const broker = new ApprovalBroker(
      (event) => events.push(event),
      async () => {
        throw new Error("disk full");
      },
    );
    const pending = broker.request("thread", "run", request());
    const approvalId = (
      events[0] as Extract<ApprovalBrokerEvent, { type: "requested" }>
    ).request.approvalId;

    await expect(broker.resolve(approvalId, "always-allow")).rejects.toThrow(
      "disk full",
    );
    await expect(pending).resolves.toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "resolved",
      decision: "allow-once",
    });
  });

  it("emits deny and settles every pending request on shutdown", async () => {
    const events: ApprovalBrokerEvent[] = [];
    const broker = new ApprovalBroker((event) => events.push(event), vi.fn());
    const pending = broker.request("thread", "run", request());
    broker.cancelAll();

    await expect(pending).resolves.toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "resolved", decision: "deny" });
  });

  it("reports allow-once when policy refuses a global exception", async () => {
    const events: ApprovalBrokerEvent[] = [];
    const broker = new ApprovalBroker(
      (event) => events.push(event),
      async () => false,
    );
    const pending = broker.request("thread", "run", request());
    const approvalId = (
      events[0] as Extract<ApprovalBrokerEvent, { type: "requested" }>
    ).request.approvalId;

    await broker.resolve(approvalId, "always-allow");
    await expect(pending).resolves.toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "resolved",
      decision: "allow-once",
    });
  });
});
