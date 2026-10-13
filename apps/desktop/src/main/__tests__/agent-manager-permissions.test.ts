import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Agent,
  checkToolPermission,
  type ModelToolCall,
  type Tool,
} from "@walle-agent/core";
import { expect, it, vi } from "vitest";
import { AgentManager } from "../agent-manager";
import { DesktopStore } from "../desktop-store";
import type { ProviderService } from "../provider-service";
import type { ThreadRecord } from "../../shared/contracts";

it.each(["auto", "full-access"] as const)(
  "enforces %s through the runtime permission policy",
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "walle-permissions-"));
    const create = vi
      .spyOn(Agent, "create")
      .mockRejectedValue(new Error("capture runtime policy"));
    try {
      const store = new DesktopStore(join(directory, "store"));
      await store.init();
      await store.updateSettings({
        permissions: { mode, denyTools: ["shell"] },
        capabilities: { skills: false, trace: false, team: false },
      });
      const thread = await store.createThread({ workspaceRoot: directory });
      const providers = {
        createModel: () => ({
          profile: { name: "Test", model: "test" },
          model: {},
        }),
      } as unknown as ProviderService;
      const manager = new AgentManager(
        store,
        providers,
        join(directory, "runtime"),
        () => undefined,
      );
      await expect(
        (
          manager as unknown as {
            ensureHandle(thread: ThreadRecord): Promise<unknown>;
          }
        ).ensureHandle(thread),
      ).rejects.toThrow("capture runtime policy");
      const policy = create.mock.calls[0][0].permissions!;
      const tool = {
        name: "shell",
        riskLevel: "high",
        requiresApproval: true,
        tags: ["shell"],
      } as Tool;
      const call = {
        id: "call",
        name: "shell",
        arguments: {},
      } as ModelToolCall;
      expect((await checkToolPermission(tool, call, policy)).allowed).toBe(
        mode === "full-access",
      );
      if (mode === "full-access") {
        expect(policy.approvalHandler).toBeUndefined();
        expect(policy.requireApprovalFor).toBeUndefined();
      }
      expect(store.getSettings().permissions.denyTools).toEqual(["shell"]);
    } finally {
      create.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
