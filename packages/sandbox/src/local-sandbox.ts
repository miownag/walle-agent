/**
 * LocalSandbox — execute commands in the host process via execa.
 *
 * Provides a thin Sandbox surface plus optional `writeFile`/`readFile`/
 * `listFiles` helpers for downstream Code-Skill executors.
 *
 * No real isolation; for actual containment use DockerSandbox. The real
 * value here is uniform timeout handling (returns `{ timedOut: true }`
 * instead of throwing) and a base-name allowlist.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execa } from "execa";
import type {
  LocalSandboxConfig,
  Sandbox,
  SandboxCommand,
  SandboxResult,
  SandboxRunner,
} from "./sandbox-types.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export class LocalSandbox implements Sandbox {
  readonly name = "local";

  private readonly runner: SandboxRunner;

  constructor(private readonly config: LocalSandboxConfig = {}) {
    this.runner = config.runner ?? (execa as unknown as SandboxRunner);
  }

  async run(command: SandboxCommand): Promise<SandboxResult> {
    // 1. Allowed-commands check (base-name only — full paths normalised).
    if (this.config.allowedCommands?.length) {
      const baseCmd = path.basename(command.cmd);
      if (!this.config.allowedCommands.includes(baseCmd)) {
        return {
          stdout: "",
          stderr: `Command not allowed: ${command.cmd}`,
          exitCode: 126,
          durationMs: 0,
        };
      }
    }

    const timeoutMs =
      command.timeoutMs ?? this.config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const started = Date.now();

    try {
      const result = await this.runner(command.cmd, command.args ?? [], {
        cwd: command.cwd ?? this.config.cwd,
        env: command.env as NodeJS.ProcessEnv | undefined,
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
      // Defensive: with `reject: false` execa shouldn't throw, but a faulty
      // runner or a missing binary can still surface here.
      const message = err instanceof Error ? err.message : String(err);
      return {
        stdout: "",
        stderr: message,
        exitCode: 1,
        durationMs: Date.now() - started,
      };
    }
  }

  async writeFile(filePath: string, content: string | Buffer): Promise<void> {
    const target = this.resolveFsPath(filePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }

  async readFile(filePath: string): Promise<string> {
    const target = this.resolveFsPath(filePath);
    return fs.readFile(target, "utf-8");
  }

  async listFiles(dir: string): Promise<string[]> {
    const target = this.resolveFsPath(dir);
    return fs.readdir(target);
  }

  async dispose(): Promise<void> {
    // Nothing to clean up — every `run()` is a one-shot child process.
  }

  private resolveFsPath(p: string): string {
    return path.isAbsolute(p)
      ? p
      : path.resolve(this.config.cwd ?? process.cwd(), p);
  }
}
