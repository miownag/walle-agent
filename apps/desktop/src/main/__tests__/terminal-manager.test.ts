import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IPty } from "node-pty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppSettings,
  TerminalDataEvent,
  TerminalExitEvent,
} from "../../shared/contracts";
import { DEFAULT_SETTINGS } from "../defaults";
import { TerminalManager } from "../terminal-manager";

class FakePty {
  pid = 42;
  cols = 80;
  rows = 24;
  process = "zsh";
  handleFlowControl = false;
  writes: string[] = [];
  killed = 0;
  cleared = 0;
  paused = 0;
  resumed = 0;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<
    (event: { exitCode: number; signal?: number }) => void
  >();

  onData = (listener: (data: string) => void) => {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  };

  onExit = (
    listener: (event: { exitCode: number; signal?: number }) => void,
  ) => {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  };

  write(data: string | Buffer): void {
    this.writes.push(String(data));
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  clear(): void {
    this.cleared += 1;
  }

  kill(): void {
    this.killed += 1;
  }

  pause(): void {
    this.paused += 1;
  }
  resume(): void {
    this.resumed += 1;
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(exitCode: number, signal?: number): void {
    for (const listener of [...this.exitListeners])
      listener({ exitCode, signal });
  }
}

describe("TerminalManager", () => {
  let workspaceRoot: string;
  let settings: AppSettings;
  let pty: FakePty;
  let dataEvents: TerminalDataEvent[];
  let exitEvents: TerminalExitEvent[];
  let spawn: ReturnType<typeof vi.fn>;
  let removeDocker: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "walle-terminal-"));
    settings = structuredClone(DEFAULT_SETTINGS);
    pty = new FakePty();
    dataEvents = [];
    exitEvents = [];
    spawn = vi.fn(() => pty as unknown as IPty);
    removeDocker = vi.fn(async () => undefined);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  function manager(
    overrides: { batchMs?: number; maxPendingOutput?: number } = {},
  ): TerminalManager {
    return new TerminalManager(
      () => settings,
      {
        data: (_ownerId, event) => dataEvents.push(event),
        exit: (_ownerId, event) => exitEvents.push(event),
      },
      {
        spawnPty: spawn,
        removeDockerContainer: removeDocker,
        platform: "darwin",
        environment: {
          SHELL: "/bin/zsh",
          PATH: "/usr/bin:/bin",
          OPENAI_API_KEY: "do-not-forward",
          ANTHROPIC_API_KEY: "do-not-forward-either",
          TMUX: "/tmp/tmux,1,0",
          TMUX_PANE: "%1",
          STY: "123.session",
          WINDOW: "2",
          WINDOWID: "99",
          TERMCAP: "nested-terminal-capabilities",
          COLUMNS: "222",
          LINES: "55",
        },
        ...overrides,
      },
    );
  }

  it("starts a workspace-bound local PTY without forwarding provider credentials", async () => {
    const terminals = manager();
    const session = await terminals.create(7, "thread-1", workspaceRoot, {
      cols: 92,
      rows: 31,
    });
    const canonicalRoot = await realpath(workspaceRoot);

    expect(session).toMatchObject({
      threadId: "thread-1",
      sandboxKind: "local",
      shell: "zsh",
    });
    expect(session.notice).toMatch(/Agent approvals/i);
    expect(spawn).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-l"],
      expect.objectContaining({ cwd: canonicalRoot, cols: 92, rows: 31 }),
    );
    const environment = spawn.mock.calls[0][2].env;
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
    for (const name of [
      "TMUX",
      "TMUX_PANE",
      "STY",
      "WINDOW",
      "WINDOWID",
      "TERMCAP",
      "COLUMNS",
      "LINES",
    ]) {
      expect(environment[name]).toBeUndefined();
    }
    expect(environment.TERM).toBe("xterm-256color");

    terminals.write(7, session.id, "pwd\r");
    terminals.resize(7, session.id, { cols: 120, rows: 40 });
    terminals.clear(7, session.id);
    expect(pty.writes).toEqual(["pwd\r"]);
    expect([pty.cols, pty.rows, pty.cleared]).toEqual([120, 40, 1]);
    expect(() => terminals.write(8, session.id, "whoami\r")).toThrow(
      /another renderer/i,
    );
    await terminals.dispose();
  });

  it("batches output and caps pending data before crossing IPC", async () => {
    vi.useFakeTimers();
    const terminals = manager({ batchMs: 16, maxPendingOutput: 12 });
    const session = await terminals.create(7, "thread-1", workspaceRoot, {
      cols: 80,
      rows: 24,
    });

    pty.emitData("abcdefghijklmnop");
    expect(dataEvents).toEqual([]);
    await vi.advanceTimersByTimeAsync(16);
    expect(dataEvents).toHaveLength(1);
    expect(dataEvents[0]).toMatchObject({
      terminalId: session.id,
      threadId: "thread-1",
      sequence: 1,
    });
    expect(dataEvents[0].data).toContain("efghijklmnop");
    expect(dataEvents[0].data).toContain("truncated terminal output");
    expect(pty.paused).toBe(1);
    terminals.acknowledge(7, session.id, 1);
    expect(pty.resumed).toBe(1);
    await terminals.dispose();
  });

  it("keeps one output batch in flight and resumes only after matching ACKs", async () => {
    vi.useFakeTimers();
    const terminals = manager({ batchMs: 16 });
    const session = await terminals.create(7, "thread-1", workspaceRoot, {
      cols: 80,
      rows: 24,
    });

    pty.emitData("first batch");
    await vi.advanceTimersByTimeAsync(16);
    expect(dataEvents.map((event) => event.sequence)).toEqual([1]);
    expect(pty.paused).toBe(1);

    // Simulate data already queued by the native stream when pause took effect.
    pty.emitData("second batch");
    await vi.advanceTimersByTimeAsync(160);
    expect(dataEvents).toHaveLength(1);
    expect(pty.resumed).toBe(0);
    terminals.acknowledge(7, session.id, 99);
    expect(dataEvents).toHaveLength(1);
    expect(() => terminals.acknowledge(8, session.id, 1)).toThrow(
      /another renderer/i,
    );

    terminals.acknowledge(7, session.id, 1);
    expect(dataEvents).toHaveLength(2);
    expect(dataEvents[1]).toMatchObject({ sequence: 2, data: "second batch" });
    expect(pty.resumed).toBe(0);

    terminals.acknowledge(7, session.id, 2);
    expect(pty.resumed).toBe(1);
    await terminals.close(7, session.id);
    expect(() => terminals.acknowledge(7, session.id, 2)).not.toThrow();
  });

  it("uses the configured Docker boundary and removes its named container", async () => {
    settings.sandbox.kind = "docker";
    settings.sandbox.dockerImage = "node:22-bookworm";
    settings.sandbox.dockerMemory = "3g";
    settings.sandbox.dockerCpus = 3;
    settings.sandbox.dockerNetwork = "none";
    const terminals = manager();
    const session = await terminals.create(4, "thread-docker", workspaceRoot, {
      cols: 100,
      rows: 35,
    });
    const canonicalRoot = await realpath(workspaceRoot);
    const [file, args] = spawn.mock.calls[0];

    expect(file).toBe("docker");
    expect(args).toEqual(
      expect.arrayContaining([
        "--rm",
        "--memory",
        "3g",
        "--cpus",
        "3",
        "--network",
        "none",
        "--volume",
        `${canonicalRoot}:/workspace`,
        "node:22-bookworm",
        "sh",
      ]),
    );
    const name = args[args.indexOf("--name") + 1];
    expect(name).toMatch(/^walle-terminal-/);

    await terminals.close(4, session.id);
    expect(pty.killed).toBe(1);
    expect(removeDocker).toHaveBeenCalledWith(name);
  });

  it("flushes output, emits exit once, and cleans up Docker after a natural exit", async () => {
    vi.useFakeTimers();
    settings.sandbox.kind = "docker";
    const terminals = manager();
    const session = await terminals.create(4, "thread-docker", workspaceRoot, {
      cols: 80,
      rows: 24,
    });
    const args = spawn.mock.calls[0][1] as string[];
    const name = args[args.indexOf("--name") + 1];

    pty.emitData("done\r\n");
    pty.emitExit(9, 15);
    expect(exitEvents).toEqual([]);
    expect(dataEvents[0]).toMatchObject({ sequence: 1, data: "done\r\n" });
    terminals.acknowledge(4, session.id, 1);
    await vi.waitFor(() =>
      expect(exitEvents).toEqual([
        {
          terminalId: session.id,
          threadId: "thread-docker",
          exitCode: 9,
          signal: 15,
        },
      ]),
    );
    expect(removeDocker).toHaveBeenCalledWith(name);
    await expect(terminals.close(4, session.id)).resolves.toBeUndefined();
  });

  it("disposes every PTY owned by a deleted thread", async () => {
    const terminals = manager();
    const first = await terminals.create(1, "thread-1", workspaceRoot, {
      cols: 80,
      rows: 24,
    });
    const secondPty = new FakePty();
    spawn.mockReturnValueOnce(secondPty as unknown as IPty);
    const second = await terminals.create(1, "thread-2", workspaceRoot, {
      cols: 80,
      rows: 24,
    });

    await terminals.disposeThread("thread-1");
    expect(pty.killed).toBe(1);
    expect(secondPty.killed).toBe(0);
    expect(() => terminals.write(1, first.id, "x")).toThrow(/unknown/i);
    terminals.write(1, second.id, "ok");
    expect(secondPty.writes).toEqual(["ok"]);
    await terminals.dispose();
  });
});
