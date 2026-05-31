import { describe, it, expect, vi } from "vitest";
import type { AgentContext, Tool } from "@walle-agent/core";
import { SandboxPlugin } from "../src/sandbox-plugin.js";
import { LocalSandbox } from "../src/local-sandbox.js";
import { DockerSandbox } from "../src/docker-sandbox.js";
import type { Sandbox, SandboxRunner } from "../src/sandbox-types.js";

function fakeContext(): {
  ctx: AgentContext;
  tools: Map<string, Tool>;
} {
  const tools = new Map<string, Tool>();
  const ctx = {
    agent: undefined,
    config: undefined,
    events: { on: () => void 0 },
    registerTool: (tool: Tool) => {
      tools.set(tool.name, tool);
    },
    registerHook: () => void 0,
    registerMiddleware: () => void 0,
    getPlugin: () => undefined,
  } as unknown as AgentContext;
  return { ctx, tools };
}

const noopRunner: SandboxRunner = vi.fn(async () => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
}));

describe("SandboxPlugin", () => {
  it("type='local' builds a LocalSandbox", () => {
    const plugin = new SandboxPlugin({
      type: "local",
      local: { cwd: "/tmp" },
      runner: noopRunner,
    });
    expect(plugin.sandbox).toBeInstanceOf(LocalSandbox);
    expect(plugin.sandbox.name).toBe("local");
  });

  it("type='docker' builds a DockerSandbox", () => {
    const plugin = new SandboxPlugin({
      type: "docker",
      docker: { image: "alpine" },
      runner: noopRunner,
    });
    expect(plugin.sandbox).toBeInstanceOf(DockerSandbox);
    expect(plugin.sandbox.name).toBe("docker");
  });

  it("install() registers the `shell` tool", async () => {
    const plugin = new SandboxPlugin({ type: "local", runner: noopRunner });
    const { ctx, tools } = fakeContext();
    await plugin.install(ctx);
    expect(tools.has("shell")).toBe(true);
    expect(tools.get("shell")!.riskLevel).toBe("high");
  });

  it("install() exposes the sandbox via ctx.__sandbox", async () => {
    const plugin = new SandboxPlugin({ type: "local", runner: noopRunner });
    const { ctx } = fakeContext();
    await plugin.install(ctx);
    const exposed = (ctx as unknown as { __sandbox?: Sandbox }).__sandbox;
    expect(exposed).toBe(plugin.sandbox);
  });

  it("getSandbox() returns the same instance", () => {
    const plugin = new SandboxPlugin({ type: "local", runner: noopRunner });
    expect(plugin.getSandbox()).toBe(plugin.sandbox);
  });

  it("dispose() forwards to sandbox.dispose", async () => {
    const plugin = new SandboxPlugin({ type: "local", runner: noopRunner });
    const spy = vi.spyOn(plugin.sandbox, "dispose").mockResolvedValue();
    await plugin.dispose();
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
