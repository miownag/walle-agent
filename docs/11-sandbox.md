# 11 — Sandbox

## 设计目标

1. 为高风险工具调用（Shell、Code Skill、文件写入）提供隔离执行环境
2. 支持 Local（直接 spawn）和 Docker 两种 sandbox
3. 超时控制、资源限制、网络隔离
4. 作为独立插件，可选使用

## 实现备忘（与本规格的偏差）

实际落地时有三处与早期 spec 文本不同，记录在此：

1. **Shell 命令解析**：spec 示例里把 `input.command` 用 `split(/\s+/)` 拆成
   `cmd + args` 直接执行，会破坏引号、管道、重定向。实现里 `shell` 工具
   把整行命令作为 `sh -c "<line>"` 的参数交给 sandbox，原封不动地保留
   shell 语义。Sandbox 接口本身仍然是 cmd-vector 的（这是正确的底层原语），
   shell 包装是工具层的事。

2. **Runner 注入测试缝**：每个 `*SandboxConfig` 多了一个可选 `runner: SandboxRunner`
   字段（默认是 `execa`），单元测试用假 runner 验证 argv 构造，不真的 spawn
   进程或调 docker。模仿了 `MCPClientFactory` 的做法。

3. **超时不抛异常**：spec 没明说，但实现选择把 execa 的 `timedOut` 投射
   到 `SandboxResult.timedOut` 字段返回，不 throw —— 跟 Phase-3 acceptance
   "工具超时正确处理" 对齐。

## 与内置 `bashTool` 的关系

`@walle-agent/core` 自带 `bashTool`（基于 `child_process.execSync`），
SandboxPlugin 又会注册一个独立的 `shell` 工具。两者共存、风险标签相同
（`riskLevel: "high"` + `requiresApproval: true` + `tags: ["builtin","shell"]`），
LLM 可能选任一个。如果你想纯走 sandbox：

```ts
Agent.create({
  …,
  plugins: [new SandboxPlugin({ type: "local" })],
  useBuiltinTools: { excludeTools: ["bash"] },
});
```

插件不会自动排除 `bashTool`，避免 `Agent.create` 行为出现魔法。

---

## Sandbox Interface

```ts
export interface Sandbox {
  name: string;

  /** 执行命令 */
  run(command: SandboxCommand): Promise<SandboxResult>;

  /** 写文件到 sandbox 环境 */
  writeFile?(path: string, content: string | Buffer): Promise<void>;

  /** 从 sandbox 环境读文件 */
  readFile?(path: string): Promise<string>;

  /** 列出 sandbox 中的文件 */
  listFiles?(dir: string): Promise<string[]>;

  /** 销毁 sandbox 释放资源 */
  dispose?(): Promise<void>;
}

export interface SandboxCommand {
  /** 命令 */
  cmd: string;

  /** 参数 */
  args?: string[];

  /** 工作目录 */
  cwd?: string;

  /** 环境变量 */
  env?: Record<string, string>;

  /** 超时（毫秒） */
  timeoutMs?: number;

  /** 标准输入 */
  stdin?: string;
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut?: boolean;
}
```

---

## Sandbox Plugin

```ts
export interface SandboxPluginConfig {
  /** 默认 sandbox 类型 */
  type: "local" | "docker";

  /** Local sandbox 配置 */
  local?: {
    /** 默认工作目录 */
    cwd?: string;
    /** 默认超时 */
    defaultTimeoutMs?: number;
    /** 允许的命令白名单（不设置则全部允许） */
    allowedCommands?: string[];
  };

  /** Docker sandbox 配置 */
  docker?: {
    image: string;
    workdir?: string;
    memory?: string;
    cpus?: number;
    network?: "none" | "bridge" | "host";
    volumes?: string[];
  };
}

export class SandboxPlugin implements WallePlugin {
  name = "sandbox";
  private sandbox: Sandbox;

  constructor(private readonly config: SandboxPluginConfig) {}

  async install(ctx: AgentContext): Promise<void> {
    this.sandbox = this.createSandbox();

    // 注册一个 shell 执行工具
    ctx.registerTool({
      name: "shell",
      description: "Execute a shell command in a sandboxed environment.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          cwd: { type: "string", description: "Working directory" },
        },
        required: ["command"],
      },
      riskLevel: "high",

      execute: async (input) => {
        const parts = input.command.split(/\s+/);
        const result = await this.sandbox.run({
          cmd: parts[0],
          args: parts.slice(1),
          cwd: input.cwd,
        });
        return result;
      },
    });
  }

  getSandbox(): Sandbox {
    return this.sandbox;
  }

  private createSandbox(): Sandbox {
    switch (this.config.type) {
      case "docker":
        return new DockerSandbox(this.config.docker!);
      case "local":
      default:
        return new LocalSandbox(this.config.local);
    }
  }

  async dispose(): Promise<void> {
    await this.sandbox.dispose?.();
  }
}
```

---

## LocalSandbox

```ts
import { execa } from "execa";

export class LocalSandbox implements Sandbox {
  name = "local";

  constructor(private readonly config?: {
    cwd?: string;
    defaultTimeoutMs?: number;
    allowedCommands?: string[];
  }) {}

  async run(command: SandboxCommand): Promise<SandboxResult> {
    // 命令白名单检查
    if (this.config?.allowedCommands?.length) {
      const baseCmd = command.cmd.split("/").pop()!;
      if (!this.config.allowedCommands.includes(baseCmd)) {
        return {
          stdout: "",
          stderr: `Command not allowed: ${command.cmd}`,
          exitCode: 126,
          durationMs: 0,
        };
      }
    }

    const timeoutMs = command.timeoutMs ?? this.config?.defaultTimeoutMs ?? 30_000;
    const started = Date.now();

    try {
      const result = await execa(command.cmd, command.args ?? [], {
        cwd: command.cwd ?? this.config?.cwd,
        env: command.env,
        timeout: timeoutMs,
        input: command.stdin,
        reject: false,
      });

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? 0,
        durationMs: Date.now() - started,
        timedOut: result.timedOut,
      };
    } catch (error: any) {
      return {
        stdout: "",
        stderr: error.message,
        exitCode: 1,
        durationMs: Date.now() - started,
      };
    }
  }
}
```

---

## DockerSandbox

```ts
import { execa } from "execa";

export class DockerSandbox implements Sandbox {
  name = "docker";
  private containerId?: string;

  constructor(private readonly config: {
    image: string;
    workdir?: string;
    memory?: string;
    cpus?: number;
    network?: "none" | "bridge" | "host";
    volumes?: string[];
  }) {}

  async run(command: SandboxCommand): Promise<SandboxResult> {
    const args = ["run", "--rm"];

    // 资源限制
    if (this.config.memory) args.push("-m", this.config.memory);
    if (this.config.cpus) args.push("--cpus", String(this.config.cpus));

    // 网络隔离
    args.push("--network", this.config.network ?? "none");

    // 工作目录
    const workdir = command.cwd ?? this.config.workdir ?? "/workspace";
    args.push("-w", workdir);

    // 卷挂载
    for (const vol of this.config.volumes ?? []) {
      args.push("-v", vol);
    }

    // 环境变量
    for (const [key, value] of Object.entries(command.env ?? {})) {
      args.push("-e", `${key}=${value}`);
    }

    // 镜像 + 命令
    args.push(this.config.image);
    args.push(command.cmd, ...(command.args ?? []));

    const timeoutMs = command.timeoutMs ?? 60_000;
    const started = Date.now();

    try {
      const result = await execa("docker", args, {
        timeout: timeoutMs,
        input: command.stdin,
        reject: false,
      });

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? 0,
        durationMs: Date.now() - started,
        timedOut: result.timedOut,
      };
    } catch (error: any) {
      return {
        stdout: "",
        stderr: error.message,
        exitCode: 1,
        durationMs: Date.now() - started,
      };
    }
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    // 通过 docker cp 或卷写入
    throw new Error("Not implemented: use volumes for file access");
  }

  async dispose(): Promise<void> {
    if (this.containerId) {
      await execa("docker", ["rm", "-f", this.containerId]).catch(() => {});
    }
  }
}
```

---

## 使用示例

```ts
import { Agent } from "@walle-agent/core";
import { OpenAIProvider } from "@walle-agent/openai";
import { SandboxPlugin } from "@walle-agent/sandbox";

const agent = await Agent.create({
  name: "Code-Agent",
  model: new OpenAIProvider({ model: "gpt-4.1" }),
  plugins: [
    new SandboxPlugin({
      type: "local",
      local: {
        cwd: "./workspace",
        defaultTimeoutMs: 10_000,
        allowedCommands: ["node", "npx", "pnpm", "cat", "ls", "grep"],
      },
    }),
  ],
});

const result = await agent.run("运行 `ls -la` 看看当前目录有什么文件");
```
