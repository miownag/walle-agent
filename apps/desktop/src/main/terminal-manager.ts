import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import { spawn as spawnPty, type IPty, type IPtyForkOptions } from "node-pty";
import type {
  AppSettings,
  SandboxKind,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalSession,
  TerminalSize,
} from "../shared/contracts";
import { WorkspaceBoundary } from "./workspace-boundary";

const DEFAULT_BATCH_MS = 16;
const DEFAULT_MAX_PENDING_OUTPUT = 256 * 1024;
const MAX_TERMINALS_PER_OWNER = 16;
const TRUNCATED_NOTICE =
  "\r\n\u001b[33m[Walle truncated terminal output to protect the app]\u001b[0m\r\n";
const STRIPPED_TERMINAL_ENV = new Set([
  "ANTHROPIC_API_KEY",
  "COLUMNS",
  "ELECTRON_RENDERER_URL",
  "LINES",
  "OPENAI_API_KEY",
  "STY",
  "TERMCAP",
  "TMUX",
  "TMUX_PANE",
  "WINDOW",
  "WINDOWID",
]);

type PtySpawn = (
  file: string,
  args: string[],
  options: IPtyForkOptions,
) => IPty;

interface TerminalManagerOptions {
  spawnPty?: PtySpawn;
  removeDockerContainer?: (name: string) => Promise<void>;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  batchMs?: number;
  maxPendingOutput?: number;
}

interface TerminalProcessSpec {
  file: string;
  args: string[];
  options: IPtyForkOptions;
  sandboxKind: SandboxKind;
  shell: string;
  dockerContainer?: string;
  notice: string;
}

interface ManagedTerminal {
  id: string;
  ownerId: number;
  threadId: string;
  pty: IPty;
  sandboxKind: SandboxKind;
  shell: string;
  dockerContainer?: string;
  pendingChunks: string[];
  pendingLength: number;
  outputTruncated: boolean;
  nextSequence: number;
  inFlightSequence?: number;
  paused: boolean;
  exitStatus?: { exitCode: number; signal?: number };
  flushTimer?: ReturnType<typeof setTimeout>;
  closed: boolean;
  dataSubscription: { dispose(): void };
  exitSubscription: { dispose(): void };
}

export interface TerminalManagerEvents {
  data(ownerId: number, event: TerminalDataEvent): void;
  exit(ownerId: number, event: TerminalExitEvent): void;
}

function terminalEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value !== "string") continue;
    // Provider fallback credentials are main-process-only data and must not be
    // inherited by a renderer-controlled shell.
    if (STRIPPED_TERMINAL_ENV.has(key)) continue;
    result[key] = value;
  }
  result.COLORTERM = "truecolor";
  result.TERM = "xterm-256color";
  result.TERM_PROGRAM = "Walle";
  return result;
}

function removeDockerContainer(name: string): Promise<void> {
  return new Promise((resolveRemove) => {
    execFile("docker", ["rm", "-f", name], { timeout: 5_000 }, () =>
      resolveRemove(),
    );
  });
}

function localShell(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string {
  if (platform === "win32") return environment.COMSPEC || "powershell.exe";
  const configured = environment.SHELL;
  if (configured && isAbsolute(configured)) return configured;
  return platform === "darwin" ? "/bin/zsh" : "/bin/sh";
}

function localSpec(
  workspaceRoot: string,
  size: TerminalSize,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): TerminalProcessSpec {
  const shell = localShell(platform, environment);
  return {
    file: shell,
    args: platform === "win32" ? [] : ["-l"],
    options: {
      name: "xterm-256color",
      cols: size.cols,
      rows: size.rows,
      cwd: workspaceRoot,
      env: terminalEnvironment(environment),
    },
    sandboxKind: "local",
    shell: basename(shell),
    notice:
      "Direct user shell on this Mac. Agent approvals and executable allowlists do not intercept terminal input.",
  };
}

function dockerSpec(
  workspaceRoot: string,
  size: TerminalSize,
  settings: AppSettings["sandbox"],
  environment: NodeJS.ProcessEnv,
): TerminalProcessSpec {
  const container = `walle-terminal-${randomUUID()}`;
  return {
    file: "docker",
    args: [
      "run",
      "--rm",
      "-i",
      "-t",
      "--name",
      container,
      "--workdir",
      "/workspace",
      "--memory",
      settings.dockerMemory,
      "--cpus",
      String(settings.dockerCpus),
      "--network",
      settings.dockerNetwork,
      "--volume",
      `${workspaceRoot}:/workspace`,
      "--env",
      "TERM=xterm-256color",
      "--env",
      "COLORTERM=truecolor",
      settings.dockerImage,
      "sh",
    ],
    options: {
      name: "xterm-256color",
      cols: size.cols,
      rows: size.rows,
      cwd: workspaceRoot,
      env: terminalEnvironment(environment),
    },
    sandboxKind: "docker",
    shell: "sh",
    dockerContainer: container,
    notice:
      "Interactive shell in the configured Docker sandbox. Agent approval rules do not intercept direct terminal input.",
  };
}

export class TerminalManager {
  private readonly sessions = new Map<string, ManagedTerminal>();
  private readonly spawnPty: PtySpawn;
  private readonly removeDockerContainer: (name: string) => Promise<void>;
  private readonly platform: NodeJS.Platform;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly batchMs: number;
  private readonly maxPendingOutput: number;

  constructor(
    private readonly getSettings: () => AppSettings,
    private readonly events: TerminalManagerEvents,
    options: TerminalManagerOptions = {},
  ) {
    this.spawnPty = options.spawnPty ?? spawnPty;
    this.removeDockerContainer =
      options.removeDockerContainer ?? removeDockerContainer;
    this.platform = options.platform ?? process.platform;
    this.environment = options.environment ?? process.env;
    this.batchMs = options.batchMs ?? DEFAULT_BATCH_MS;
    this.maxPendingOutput =
      options.maxPendingOutput ?? DEFAULT_MAX_PENDING_OUTPUT;
  }

  async create(
    ownerId: number,
    threadId: string,
    workspaceRoot: string,
    size: TerminalSize,
  ): Promise<TerminalSession> {
    const ownerCount = [...this.sessions.values()].filter(
      (session) => session.ownerId === ownerId,
    ).length;
    if (ownerCount >= MAX_TERMINALS_PER_OWNER)
      throw new Error("Too many terminal sessions are open");

    const boundary = await WorkspaceBoundary.create(workspaceRoot);
    const settings = this.getSettings();
    const spec =
      settings.sandbox.kind === "docker"
        ? dockerSpec(boundary.root, size, settings.sandbox, this.environment)
        : localSpec(boundary.root, size, this.platform, this.environment);
    const pty = this.spawnPty(spec.file, spec.args, spec.options);
    const id = randomUUID();
    const session = {} as ManagedTerminal;
    Object.assign(session, {
      id,
      ownerId,
      threadId,
      pty,
      sandboxKind: spec.sandboxKind,
      shell: spec.shell,
      dockerContainer: spec.dockerContainer,
      pendingChunks: [],
      pendingLength: 0,
      outputTruncated: false,
      nextSequence: 0,
      paused: false,
      closed: false,
      dataSubscription: pty.onData((data) => this.queueOutput(session, data)),
      exitSubscription: pty.onExit(
        (event) => void this.finish(session, event.exitCode, event.signal),
      ),
    } satisfies ManagedTerminal);
    this.sessions.set(id, session);
    return {
      id,
      threadId,
      sandboxKind: spec.sandboxKind,
      shell: spec.shell,
      size,
      notice: spec.notice,
    };
  }

  write(ownerId: number, terminalId: string, data: string): void {
    const session = this.owned(ownerId, terminalId);
    if (!session.closed) session.pty.write(data);
  }

  acknowledge(ownerId: number, terminalId: string, sequence: number): void {
    const session = this.sessions.get(terminalId);
    // xterm's write callback may arrive after process/window cleanup.
    if (!session) return;
    if (session.ownerId !== ownerId)
      throw new Error("Terminal session belongs to another renderer");
    if (session.inFlightSequence !== sequence) return;
    session.inFlightSequence = undefined;

    if (session.pendingLength || session.outputTruncated) {
      this.flushOutput(session);
      return;
    }
    if (session.exitStatus) {
      void this.finalizeExit(session);
      return;
    }
    if (session.paused) {
      session.pty.resume();
      session.paused = false;
    }
  }

  resize(ownerId: number, terminalId: string, size: TerminalSize): void {
    const session = this.owned(ownerId, terminalId);
    if (
      !session.closed &&
      (session.pty.cols !== size.cols || session.pty.rows !== size.rows)
    ) {
      session.pty.resize(size.cols, size.rows);
    }
  }

  clear(ownerId: number, terminalId: string): void {
    const session = this.owned(ownerId, terminalId);
    if (!session.closed) session.pty.clear();
  }

  async close(ownerId: number, terminalId: string): Promise<void> {
    const session = this.sessions.get(terminalId);
    if (!session) return;
    if (session.ownerId !== ownerId)
      throw new Error("Terminal session belongs to another renderer");
    await this.disposeSession(session);
  }

  async disposeThread(threadId: string): Promise<void> {
    await Promise.all(
      [...this.sessions.values()]
        .filter((session) => session.threadId === threadId)
        .map((session) => this.disposeSession(session)),
    );
  }

  async disposeOwner(ownerId: number): Promise<void> {
    await Promise.all(
      [...this.sessions.values()]
        .filter((session) => session.ownerId === ownerId)
        .map((session) => this.disposeSession(session)),
    );
  }

  async dispose(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].map((session) =>
        this.disposeSession(session),
      ),
    );
  }

  private owned(ownerId: number, terminalId: string): ManagedTerminal {
    const session = this.sessions.get(terminalId);
    if (!session) throw new Error("Unknown terminal session");
    if (session.ownerId !== ownerId)
      throw new Error("Terminal session belongs to another renderer");
    return session;
  }

  private queueOutput(session: ManagedTerminal, data: string): void {
    if (session.closed || !data) return;
    session.pendingChunks.push(data);
    session.pendingLength += data.length;
    while (
      session.pendingLength > this.maxPendingOutput &&
      session.pendingChunks.length
    ) {
      const overflow = session.pendingLength - this.maxPendingOutput;
      const first = session.pendingChunks[0];
      if (first.length <= overflow) {
        session.pendingChunks.shift();
        session.pendingLength -= first.length;
      } else {
        session.pendingChunks[0] = first.slice(overflow);
        session.pendingLength -= overflow;
      }
      session.outputTruncated = true;
    }
    if (session.inFlightSequence === undefined) {
      session.flushTimer ??= setTimeout(
        () => this.flushOutput(session),
        this.batchMs,
      );
    }
  }

  private flushOutput(session: ManagedTerminal): void {
    if (session.flushTimer) clearTimeout(session.flushTimer);
    session.flushTimer = undefined;
    if (session.inFlightSequence !== undefined) return;
    if (!session.pendingLength && !session.outputTruncated) return;
    const data = `${session.outputTruncated ? TRUNCATED_NOTICE : ""}${session.pendingChunks.join("")}`;
    session.pendingChunks = [];
    session.pendingLength = 0;
    session.outputTruncated = false;
    if (!session.paused && !session.exitStatus) {
      session.pty.pause();
      session.paused = true;
    }
    const sequence = ++session.nextSequence;
    session.inFlightSequence = sequence;
    try {
      this.events.data(session.ownerId, {
        terminalId: session.id,
        threadId: session.threadId,
        sequence,
        data,
      });
    } catch (error) {
      session.inFlightSequence = undefined;
      if (session.paused && !session.exitStatus) {
        session.pty.resume();
        session.paused = false;
      }
      throw error;
    }
  }

  private async finish(
    session: ManagedTerminal,
    exitCode: number,
    signal?: number,
  ): Promise<void> {
    if (session.closed || session.exitStatus) return;
    session.exitStatus = { exitCode, signal };
    if (session.flushTimer) clearTimeout(session.flushTimer);
    session.flushTimer = undefined;
    session.dataSubscription.dispose();
    if (session.inFlightSequence !== undefined) return;
    if (session.pendingLength || session.outputTruncated) {
      try {
        this.flushOutput(session);
      } catch {
        await this.disposeSession(session);
      }
      return;
    }
    await this.finalizeExit(session);
  }

  private async finalizeExit(session: ManagedTerminal): Promise<void> {
    if (session.closed || !session.exitStatus) return;
    session.closed = true;
    this.sessions.delete(session.id);
    session.exitSubscription.dispose();
    const { exitCode, signal } = session.exitStatus;
    try {
      this.events.exit(session.ownerId, {
        terminalId: session.id,
        threadId: session.threadId,
        exitCode,
        signal,
      });
    } catch {
      // The renderer can disappear between the PTY exit and event delivery.
    } finally {
      if (session.dockerContainer)
        await this.removeDockerContainer(session.dockerContainer);
    }
  }

  private async disposeSession(session: ManagedTerminal): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    this.sessions.delete(session.id);
    if (session.flushTimer) clearTimeout(session.flushTimer);
    session.pendingChunks = [];
    session.pendingLength = 0;
    session.dataSubscription.dispose();
    session.exitSubscription.dispose();
    try {
      session.pty.kill();
    } catch {
      // The PTY may have exited between the renderer request and cleanup.
    }
    if (session.dockerContainer)
      await this.removeDockerContainer(session.dockerContainer);
  }
}
