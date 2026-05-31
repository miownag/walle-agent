/**
 * DockerSandbox — execute commands inside an ephemeral container via the
 * docker CLI. Spec mirrors `docs/11-sandbox.md`.
 *
 * Each `run()` shells out `docker run --rm <flags> <image> <cmd> [args]`;
 * we never keep a long-lived container, so `dispose()` is essentially a
 * no-op. File mounts are the user's responsibility (`config.volumes`).
 */

import { execa } from "execa";
import type {
  DockerSandboxConfig,
  Sandbox,
  SandboxCommand,
  SandboxResult,
  SandboxRunner,
} from "./sandbox-types.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_WORKDIR = "/workspace";
const DEFAULT_NETWORK = "none" as const;

export class DockerSandbox implements Sandbox {
  readonly name = "docker";

  private readonly runner: SandboxRunner;

  constructor(private readonly config: DockerSandboxConfig) {
    this.runner = config.runner ?? (execa as unknown as SandboxRunner);
  }

  async run(command: SandboxCommand): Promise<SandboxResult> {
    const args = this.buildArgs(command);
    const timeoutMs = command.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const started = Date.now();

    try {
      const result = await this.runner("docker", args, {
        timeout: timeoutMs,
        input: command.stdin,
        reject: false,
      });

      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? 0,
        durationMs: Date.now() - started,
        timedOut: result.timedOut,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        stdout: "",
        stderr: message,
        exitCode: 1,
        durationMs: Date.now() - started,
      };
    }
  }

  /** Spec explicitly defers file I/O to volume mounts. */
  async writeFile(_filePath: string, _content: string | Buffer): Promise<void> {
    throw new Error("Not implemented: use volumes for file access");
  }

  async dispose(): Promise<void> {
    // Each run uses `--rm`; no long-lived state to clean up.
  }

  private buildArgs(command: SandboxCommand): string[] {
    const args: string[] = ["run", "--rm"];

    // Resource limits.
    if (this.config.memory) args.push("-m", this.config.memory);
    if (typeof this.config.cpus === "number") {
      args.push("--cpus", String(this.config.cpus));
    }

    // Network isolation.
    args.push("--network", this.config.network ?? DEFAULT_NETWORK);

    // Working directory.
    const workdir =
      command.cwd ?? this.config.workdir ?? DEFAULT_WORKDIR;
    args.push("-w", workdir);

    // Volume mounts.
    for (const vol of this.config.volumes ?? []) {
      args.push("-v", vol);
    }

    // Environment variables.
    for (const [key, value] of Object.entries(command.env ?? {})) {
      args.push("-e", `${key}=${value}`);
    }

    // Image + command.
    args.push(this.config.image);
    args.push(command.cmd, ...(command.args ?? []));

    return args;
  }
}
