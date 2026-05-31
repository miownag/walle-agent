/**
 * Sandbox types — isolated execution environments for high-risk tools.
 *
 * Mirrors `docs/11-sandbox.md`. Two implementations ship: LocalSandbox
 * (direct exec via execa) and DockerSandbox (docker CLI via execa).
 *
 * The `runner` field on each config is a test seam — pass a fake function
 * to avoid spinning up real processes (or docker) in unit tests. Defaults
 * to `execa`. Matches the `MCPClientFactory` pattern in `@walle-agent/mcp`.
 */

// ─── Sandbox interface ─────────────────────────────────────────────

export interface SandboxCommand {
  /** Executable. */
  cmd: string;
  /** Argv after the executable. */
  args?: string[];
  /** Working directory for the command. */
  cwd?: string;
  /** Environment variables (merged with process env by the runner). */
  env?: Record<string, string>;
  /** Timeout in milliseconds. Falls back to sandbox config default. */
  timeoutMs?: number;
  /** Pipe to stdin. */
  stdin?: string;
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  /** True if the command was killed for exceeding `timeoutMs`. */
  timedOut?: boolean;
}

export interface Sandbox {
  /** "local" | "docker" — implementation tag. */
  name: string;
  run(command: SandboxCommand): Promise<SandboxResult>;
  writeFile?(path: string, content: string | Buffer): Promise<void>;
  readFile?(path: string): Promise<string>;
  listFiles?(dir: string): Promise<string[]>;
  dispose?(): Promise<void>;
}

// ─── Runner abstraction (test seam) ────────────────────────────────

/**
 * Minimal subset of execa's signature consumed by sandboxes. Default
 * binding is execa itself; tests pass a fake to assert on argv without
 * spawning real processes.
 */
export interface SandboxRunner {
  (
    file: string,
    args: string[],
    options: SandboxRunnerOptions,
  ): Promise<SandboxRunnerResult>;
}

export interface SandboxRunnerOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Milliseconds; runner kills the child after this. */
  timeout?: number;
  /** Piped to child's stdin. */
  input?: string;
  /** Always `false` — we want non-zero exit codes as resolved values, not throws. */
  reject?: false;
}

export interface SandboxRunnerResult {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
  timedOut?: boolean;
}

// ─── Configs ───────────────────────────────────────────────────────

export interface LocalSandboxConfig {
  /** Default working directory for commands and file ops. */
  cwd?: string;
  /** Default timeout when `command.timeoutMs` is omitted. Default 30s. */
  defaultTimeoutMs?: number;
  /**
   * Base-name whitelist (e.g. `["node","ls","grep"]`). When set, any command
   * whose `path.basename(cmd)` isn't in the list resolves with exit code 126
   * instead of running.
   */
  allowedCommands?: string[];
  /** Test seam — replaces execa. */
  runner?: SandboxRunner;
}

export interface DockerSandboxConfig {
  /** Image to run, e.g. `"node:20-alpine"`. */
  image: string;
  /** Default working directory inside the container. Default `/workspace`. */
  workdir?: string;
  /** `-m` value, e.g. `"512m"`. */
  memory?: string;
  /** `--cpus` value. */
  cpus?: number;
  /** `--network`. Default `"none"`. */
  network?: "none" | "bridge" | "host";
  /** `-v` mounts, e.g. `["/host:/container:ro"]`. */
  volumes?: string[];
  /** Test seam — replaces execa. */
  runner?: SandboxRunner;
}

export type SandboxPluginConfig =
  | {
      type: "local";
      local?: Omit<LocalSandboxConfig, "runner">;
      runner?: SandboxRunner;
    }
  | {
      type: "docker";
      docker: Omit<DockerSandboxConfig, "runner">;
      runner?: SandboxRunner;
    };
