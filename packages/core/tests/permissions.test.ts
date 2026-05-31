import { describe, it, expect, vi } from "vitest";
import { defineTool } from "../src/tool.js";
import { checkToolPermission } from "../src/permissions.js";
import type {
  ApprovalRequest,
  PermissionPolicy,
} from "../src/permissions.js";
import type { ModelToolCall } from "../src/message.js";

const makeCall = (name: string, args: Record<string, unknown> = {}): ModelToolCall => ({
  id: "tc-1",
  name,
  arguments: args,
});

const lowTool = defineTool({
  name: "noop",
  description: "no-op",
  parameters: { type: "object", properties: {} },
  riskLevel: "low",
  async execute() {
    return { ok: true };
  },
});

const mediumTool = defineTool({
  name: "save_file",
  description: "save file",
  parameters: { type: "object", properties: {} },
  riskLevel: "medium",
  requiresApproval: true,
  tags: ["filesystem", "file-write"],
  async execute() {
    return { ok: true };
  },
});

const highTool = defineTool({
  name: "bash",
  description: "shell",
  parameters: { type: "object", properties: {} },
  riskLevel: "high",
  requiresApproval: true,
  tags: ["shell"],
  async execute() {
    return { ok: true };
  },
});

const networkTool = defineTool({
  name: "fetch",
  description: "http",
  parameters: { type: "object", properties: {} },
  riskLevel: "medium",
  tags: ["network"],
  async execute() {
    return { ok: true };
  },
});

describe("checkToolPermission", () => {
  describe("denyTools / allowTools", () => {
    it("denyTools blocks even when mode would otherwise allow", async () => {
      const policy: PermissionPolicy = { denyTools: ["noop"] };
      const decision = await checkToolPermission(lowTool, makeCall("noop"), policy);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toMatch(/denied/);
    });

    it("denyTools beats allowTools when both match", async () => {
      const policy: PermissionPolicy = {
        denyTools: ["noop"],
        allowTools: ["noop"],
      };
      const decision = await checkToolPermission(lowTool, makeCall("noop"), policy);
      expect(decision.allowed).toBe(false);
    });

    it("allowTools short-circuits to allow even for high-risk + ask mode", async () => {
      const policy: PermissionPolicy = {
        mode: "ask",
        allowTools: ["bash"],
        requireApprovalFor: { riskLevel: ["high"] },
        approvalHandler: async () => false, // would deny if reached
      };
      const decision = await checkToolPermission(highTool, makeCall("bash"), policy);
      expect(decision.allowed).toBe(true);
    });
  });

  describe("mode: deny-high-risk", () => {
    it("blocks tools with riskLevel === 'high'", async () => {
      const policy: PermissionPolicy = { mode: "deny-high-risk" };
      const decision = await checkToolPermission(highTool, makeCall("bash"), policy);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toMatch(/high-risk/i);
    });

    it("allows medium and low risk tools", async () => {
      const policy: PermissionPolicy = { mode: "deny-high-risk" };
      expect((await checkToolPermission(mediumTool, makeCall("save_file"), policy)).allowed).toBe(true);
      expect((await checkToolPermission(lowTool, makeCall("noop"), policy)).allowed).toBe(true);
    });
  });

  describe("requireApprovalFor", () => {
    it("riskLevel match triggers approvalHandler; approve → allow", async () => {
      const handler = vi.fn(async () => true);
      const policy: PermissionPolicy = {
        requireApprovalFor: { riskLevel: ["high"] },
        approvalHandler: handler,
      };
      const decision = await checkToolPermission(highTool, makeCall("bash", { c: "ls" }), policy);
      expect(decision.allowed).toBe(true);
      expect(handler).toHaveBeenCalledOnce();
      const req = handler.mock.calls[0][0] as ApprovalRequest;
      expect(req.tool).toBe(highTool);
      expect(req.riskLevel).toBe("high");
      expect(req.description).toMatch(/bash/);
      expect(req.description).toMatch(/"c":"ls"/);
    });

    it("riskLevel match — handler denies → deny", async () => {
      const policy: PermissionPolicy = {
        requireApprovalFor: { riskLevel: ["high"] },
        approvalHandler: async () => false,
      };
      const decision = await checkToolPermission(highTool, makeCall("bash"), policy);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toMatch(/Approval denied/);
    });

    it("toolNames match triggers approval", async () => {
      const handler = vi.fn(async () => false);
      const policy: PermissionPolicy = {
        requireApprovalFor: { toolNames: ["noop"] },
        approvalHandler: handler,
      };
      const decision = await checkToolPermission(lowTool, makeCall("noop"), policy);
      expect(decision.allowed).toBe(false);
      expect(handler).toHaveBeenCalledOnce();
    });

    it("shell tag match", async () => {
      const handler = vi.fn(async () => true);
      const policy: PermissionPolicy = {
        requireApprovalFor: { shell: true },
        approvalHandler: handler,
      };
      await checkToolPermission(highTool, makeCall("bash"), policy);
      expect(handler).toHaveBeenCalledOnce();
    });

    it("fileWrite tag match", async () => {
      const handler = vi.fn(async () => true);
      const policy: PermissionPolicy = {
        requireApprovalFor: { fileWrite: true },
        approvalHandler: handler,
      };
      await checkToolPermission(mediumTool, makeCall("save_file"), policy);
      expect(handler).toHaveBeenCalledOnce();
    });

    it("network tag match", async () => {
      const handler = vi.fn(async () => true);
      const policy: PermissionPolicy = {
        requireApprovalFor: { network: true },
        approvalHandler: handler,
      };
      await checkToolPermission(networkTool, makeCall("fetch"), policy);
      expect(handler).toHaveBeenCalledOnce();
    });

    it("tool.requiresApproval triggers when requireApprovalFor is set", async () => {
      const handler = vi.fn(async () => true);
      const policy: PermissionPolicy = {
        requireApprovalFor: {}, // no specific rules, but the master switch is on
        approvalHandler: handler,
      };
      // mediumTool has requiresApproval: true.
      await checkToolPermission(mediumTool, makeCall("save_file"), policy);
      expect(handler).toHaveBeenCalledOnce();
    });

    it("tool.requiresApproval is IGNORED when requireApprovalFor is unset (master switch)", async () => {
      const handler = vi.fn(async () => false);
      const policy: PermissionPolicy = { approvalHandler: handler };
      const decision = await checkToolPermission(mediumTool, makeCall("save_file"), policy);
      expect(decision.allowed).toBe(true);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("missing approvalHandler", () => {
    it("ask mode + needs approval + no handler → deny", async () => {
      const policy: PermissionPolicy = {
        mode: "ask",
        requireApprovalFor: { riskLevel: ["high"] },
      };
      const decision = await checkToolPermission(highTool, makeCall("bash"), policy);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toMatch(/no handler/i);
    });

    it("auto mode + needs approval + no handler → silent allow", async () => {
      const policy: PermissionPolicy = {
        mode: "auto",
        requireApprovalFor: { riskLevel: ["high"] },
      };
      const decision = await checkToolPermission(highTool, makeCall("bash"), policy);
      expect(decision.allowed).toBe(true);
    });
  });

  describe("approvalHandler errors", () => {
    it("throwing handler is treated as deny + logged", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const policy: PermissionPolicy = {
        requireApprovalFor: { riskLevel: ["high"] },
        approvalHandler: async () => {
          throw new Error("boom");
        },
      };
      const decision = await checkToolPermission(highTool, makeCall("bash"), policy);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toMatch(/handler error/i);
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe("default behaviour", () => {
    it("empty policy allows everything", async () => {
      const policy: PermissionPolicy = {};
      expect((await checkToolPermission(lowTool, makeCall("noop"), policy)).allowed).toBe(true);
      expect((await checkToolPermission(mediumTool, makeCall("save_file"), policy)).allowed).toBe(true);
      expect((await checkToolPermission(highTool, makeCall("bash"), policy)).allowed).toBe(true);
    });

    it("description truncates very long arguments", async () => {
      const handler = vi.fn(async () => true);
      const policy: PermissionPolicy = {
        requireApprovalFor: { riskLevel: ["high"] },
        approvalHandler: handler,
      };
      const huge = "x".repeat(5000);
      await checkToolPermission(highTool, makeCall("bash", { payload: huge }), policy);
      const req = handler.mock.calls[0][0] as ApprovalRequest;
      expect(req.description.length).toBeLessThan(huge.length);
      expect(req.description.endsWith("…")).toBe(true);
    });
  });
});
