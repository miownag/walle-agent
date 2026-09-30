import { basename, isAbsolute, posix, relative, resolve, sep } from "node:path";
import {
  DockerSandbox,
  LocalSandbox,
  type Sandbox,
  type SandboxCommand,
  type SandboxResult,
} from "@walle-agent/sandbox";
import type { SandboxSettings } from "../shared/contracts";
import { WorkspaceBoundary } from "./workspace-boundary";

function commandNames(script: string): string[] {
  if (/`|\$\(/.test(script)) {
    throw new Error(
      "Command substitution is unavailable while an executable allowlist is active",
    );
  }
  return script
    .split(/(?:&&|\|\||[;|\n])/)
    .map((segment) => segment.trim().replace(/^[({]+\s*/, ""))
    .filter(Boolean)
    .map((segment) => {
      const words = segment.split(/\s+/).filter(Boolean);
      while (
        words[0]?.includes("=") &&
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])
      )
        words.shift();
      return basename((words[0] ?? "").replace(/^['"]|['"]$/g, ""));
    })
    .filter(Boolean);
}

export class WorkspaceSandbox implements Sandbox {
  readonly name: string;
  private readonly backend: Sandbox;

  private constructor(
    private readonly boundary: WorkspaceBoundary,
    private readonly settings: SandboxSettings,
  ) {
    this.name = settings.kind;
    this.backend =
      settings.kind === "docker"
        ? new DockerSandbox({
            image: settings.dockerImage,
            workdir: "/workspace",
            memory: settings.dockerMemory,
            cpus: settings.dockerCpus,
            network: settings.dockerNetwork,
            volumes: [`${boundary.root}:/workspace`],
          })
        : new LocalSandbox({
            cwd: boundary.root,
            defaultTimeoutMs: settings.timeoutMs,
          });
  }

  static async create(
    workspaceRoot: string,
    settings: SandboxSettings,
  ): Promise<WorkspaceSandbox> {
    return new WorkspaceSandbox(
      await WorkspaceBoundary.create(workspaceRoot),
      settings,
    );
  }

  async run(command: SandboxCommand): Promise<SandboxResult> {
    this.assertAllowed(command);
    const cwd = await this.resolveCwd(command.cwd);
    return this.backend.run({
      ...command,
      cwd,
      timeoutMs: command.timeoutMs ?? this.settings.timeoutMs,
    });
  }

  async dispose(): Promise<void> {
    await this.backend.dispose?.();
  }

  private assertAllowed(command: SandboxCommand): void {
    const allowed = this.settings.allowedCommands;
    if (!allowed.length) return;
    const names =
      command.cmd === "sh" && command.args?.[0] === "-c"
        ? commandNames(command.args[1] ?? "")
        : [basename(command.cmd)];
    const denied = names.find((name) => !allowed.includes(name));
    if (denied) throw new Error(`Command not allowed: ${denied}`);
  }

  private async resolveCwd(requested?: string): Promise<string> {
    if (this.settings.kind === "docker") {
      if (!requested) return "/workspace";
      if (requested === "/workspace" || requested.startsWith("/workspace/")) {
        const normalized = posix.resolve(requested);
        if (
          normalized !== "/workspace" &&
          !normalized.startsWith("/workspace/")
        )
          throw new Error("Command cwd escapes the workspace mount");
        return normalized;
      }
      const hostPath = isAbsolute(requested)
        ? requested
        : resolve(this.boundary.root, requested);
      const rel = relative(this.boundary.root, hostPath);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        throw new Error("Command cwd escapes the workspace root");
      await this.boundary.assertDirectory(rel);
      return posix.join("/workspace", ...rel.split(sep));
    }
    if (!requested) return this.boundary.root;
    const rel = isAbsolute(requested)
      ? relative(this.boundary.root, requested)
      : requested;
    return this.boundary.assertDirectory(rel);
  }
}
