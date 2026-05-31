import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { LocalSandbox } from "../src/local-sandbox.js";
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

describe("LocalSandbox.run", () => {
  it("returns stdout/stderr/exitCode from the runner", async () => {
    const { runner } = fakeRunner({ stdout: "hi", stderr: "warn", exitCode: 0 });
    const sb = new LocalSandbox({ runner });
    const res = await sb.run({ cmd: "echo", args: ["hi"] });
    expect(res.stdout).toBe("hi");
    expect(res.stderr).toBe("warn");
    expect(res.exitCode).toBe(0);
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("forwards cwd, env, stdin, timeout to the runner", async () => {
    const { runner, calls } = fakeRunner();
    const sb = new LocalSandbox({ runner, cwd: "/default", defaultTimeoutMs: 5000 });
    await sb.run({
      cmd: "node",
      args: ["script.js"],
      cwd: "/override",
      env: { FOO: "bar" },
      stdin: "input!",
      timeoutMs: 1000,
    });
    expect(calls[0]).toMatchObject({
      file: "node",
      args: ["script.js"],
      options: {
        cwd: "/override",
        env: { FOO: "bar" },
        timeout: 1000,
        input: "input!",
        reject: false,
      },
    });
  });

  it("falls back to defaultTimeoutMs (30s) when neither override nor config provides one", async () => {
    const { runner, calls } = fakeRunner();
    const sb = new LocalSandbox({ runner });
    await sb.run({ cmd: "echo" });
    expect(calls[0].options.timeout).toBe(30_000);
  });

  it("config.defaultTimeoutMs beats the 30s default", async () => {
    const { runner, calls } = fakeRunner();
    const sb = new LocalSandbox({ runner, defaultTimeoutMs: 5000 });
    await sb.run({ cmd: "echo" });
    expect(calls[0].options.timeout).toBe(5000);
  });

  it("propagates timedOut from runner instead of throwing", async () => {
    const { runner } = fakeRunner({ timedOut: true, exitCode: undefined, stdout: "", stderr: "" });
    const sb = new LocalSandbox({ runner });
    const res = await sb.run({ cmd: "sleep", args: ["100"], timeoutMs: 100 });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBe(0); // exitCode falls back to 0 when undefined
  });

  it("blocks unlisted commands via allowedCommands (exit 126)", async () => {
    const { runner, calls } = fakeRunner();
    const sb = new LocalSandbox({ runner, allowedCommands: ["node", "ls"] });
    const res = await sb.run({ cmd: "rm", args: ["-rf", "/"] });
    expect(res.exitCode).toBe(126);
    expect(res.stderr).toMatch(/not allowed/);
    expect(calls).toHaveLength(0); // runner never called
  });

  it("allowedCommands matches base name even when given a full path", async () => {
    const { runner, calls } = fakeRunner();
    const sb = new LocalSandbox({ runner, allowedCommands: ["node"] });
    await sb.run({ cmd: "/usr/local/bin/node", args: ["-v"] });
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("/usr/local/bin/node");
  });

  it("converts a thrown runner error to exitCode 1 + stderr", async () => {
    const runner: SandboxRunner = vi.fn(async () => {
      throw new Error("ENOENT: spawn nope");
    });
    const sb = new LocalSandbox({ runner });
    const res = await sb.run({ cmd: "nope" });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/ENOENT/);
  });
});

describe("LocalSandbox file ops", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "walle-sb-fs-"));
  });

  it("writeFile + readFile round-trip relative to cwd", async () => {
    const sb = new LocalSandbox({ cwd: dir, runner: vi.fn() as unknown as SandboxRunner });
    await sb.writeFile("a/b/c.txt", "hello");
    const content = await sb.readFile("a/b/c.txt");
    expect(content).toBe("hello");
  });

  it("listFiles returns directory entries", async () => {
    const sb = new LocalSandbox({ cwd: dir, runner: vi.fn() as unknown as SandboxRunner });
    await sb.writeFile("one.txt", "1");
    await sb.writeFile("two.txt", "2");
    const entries = await sb.listFiles(".");
    expect(entries.sort()).toEqual(["one.txt", "two.txt"]);
  });

  it("absolute paths bypass cwd resolution", async () => {
    const sb = new LocalSandbox({ cwd: "/never/used", runner: vi.fn() as unknown as SandboxRunner });
    const target = path.join(dir, "abs.txt");
    await sb.writeFile(target, "ok");
    expect(await sb.readFile(target)).toBe("ok");
  });
});

describe("LocalSandbox.dispose", () => {
  it("resolves without doing anything", async () => {
    const sb = new LocalSandbox({ runner: vi.fn() as unknown as SandboxRunner });
    await expect(sb.dispose()).resolves.toBeUndefined();
  });
});
