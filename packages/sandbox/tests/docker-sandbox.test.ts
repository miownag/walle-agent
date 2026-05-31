import { describe, it, expect, vi } from "vitest";
import { DockerSandbox } from "../src/docker-sandbox.js";
import type {
  SandboxRunner,
  SandboxRunnerOptions,
  SandboxRunnerResult,
} from "../src/sandbox-types.js";

interface RunnerCall {
  file: string;
  args: string[];
  options: SandboxRunnerOptions;
}

function fakeRunner(
  result: Partial<SandboxRunnerResult> = {},
): { runner: SandboxRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const runner: SandboxRunner = vi.fn(async (file, args, options) => {
    calls.push({ file, args, options });
    return {
      stdout: "",
      stderr: "",
      exitCode: 0,
      ...result,
    };
  });
  return { runner, calls };
}

describe("DockerSandbox.run argv", () => {
  it("builds the minimal `docker run --rm` argv", async () => {
    const { runner, calls } = fakeRunner();
    const sb = new DockerSandbox({ image: "alpine", runner });
    await sb.run({ cmd: "echo", args: ["hi"] });

    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("docker");
    // Default workdir, default network "none", no resource limits, no volumes.
    expect(calls[0].args).toEqual([
      "run",
      "--rm",
      "--network",
      "none",
      "-w",
      "/workspace",
      "alpine",
      "echo",
      "hi",
    ]);
  });

  it("adds memory, cpus, network, workdir, volumes, env in order", async () => {
    const { runner, calls } = fakeRunner();
    const sb = new DockerSandbox({
      image: "node:20-alpine",
      memory: "512m",
      cpus: 2,
      network: "bridge",
      workdir: "/app",
      volumes: ["/host:/container:ro", "/data:/data"],
      runner,
    });
    await sb.run({
      cmd: "node",
      args: ["-v"],
      env: { NODE_ENV: "production", DEBUG: "*" },
    });

    expect(calls[0].args).toEqual([
      "run",
      "--rm",
      "-m",
      "512m",
      "--cpus",
      "2",
      "--network",
      "bridge",
      "-w",
      "/app",
      "-v",
      "/host:/container:ro",
      "-v",
      "/data:/data",
      "-e",
      "NODE_ENV=production",
      "-e",
      "DEBUG=*",
      "node:20-alpine",
      "node",
      "-v",
    ]);
  });

  it("command.cwd overrides config.workdir", async () => {
    const { runner, calls } = fakeRunner();
    const sb = new DockerSandbox({ image: "alpine", workdir: "/app", runner });
    await sb.run({ cmd: "ls", cwd: "/tmp" });
    expect(calls[0].args).toContain("/tmp");
    expect(calls[0].args).not.toContain("/app");
  });

  it("default timeout is 60s, override via command.timeoutMs honoured", async () => {
    const { runner, calls } = fakeRunner();
    const sb = new DockerSandbox({ image: "alpine", runner });
    await sb.run({ cmd: "echo" });
    expect(calls[0].options.timeout).toBe(60_000);

    await sb.run({ cmd: "echo", timeoutMs: 5_000 });
    expect(calls[1].options.timeout).toBe(5_000);
  });

  it("returns timedOut from runner", async () => {
    const { runner } = fakeRunner({ timedOut: true });
    const sb = new DockerSandbox({ image: "alpine", runner });
    const res = await sb.run({ cmd: "sleep", args: ["100"] });
    expect(res.timedOut).toBe(true);
  });

  it("converts a runner throw to exit 1 + stderr", async () => {
    const runner: SandboxRunner = vi.fn(async () => {
      throw new Error("docker daemon unreachable");
    });
    const sb = new DockerSandbox({ image: "alpine", runner });
    const res = await sb.run({ cmd: "echo" });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/docker daemon/);
  });
});

describe("DockerSandbox file ops", () => {
  it("writeFile throws the spec'd 'use volumes' error", async () => {
    const sb = new DockerSandbox({ image: "alpine", runner: vi.fn() as unknown as SandboxRunner });
    await expect(sb.writeFile("/foo", "bar")).rejects.toThrow(/volumes/);
  });

  it("dispose is a no-op (--rm covers cleanup)", async () => {
    const sb = new DockerSandbox({ image: "alpine", runner: vi.fn() as unknown as SandboxRunner });
    await expect(sb.dispose()).resolves.toBeUndefined();
  });
});
