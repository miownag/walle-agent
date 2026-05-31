# 07 — MCP Integration

## 设计目标

1. MCP Server 暴露的 tools 统一适配为内部 `Tool`，对 Runtime 透明。
2. 支持 stdio / Streamable HTTP 两种 transport。
3. 支持工具白名单/黑名单过滤与自定义前缀。
4. 作为独立插件包 (`@walle-agent/mcp`)，不污染 core。
5. MCP 工具的错误 (`isError: true`) 等价于原生工具抛出异常，复用 core 的
   tool-call 错误路径。

---

## 包布局

```
packages/mcp/
├── package.json                    # peer: @walle-agent/core
├── src/
│   ├── index.ts                    # 公开 API re-exports
│   ├── mcp-plugin.ts               # WallePlugin 实现
│   ├── mcp-client-manager.ts       # 连接生命周期 + listTools 过滤
│   ├── mcp-tool-adapter.ts         # MCP tool → internal Tool
│   └── mcp-config.ts               # MCPServerConfig + transports
└── tests/
    ├── mcp-tool-adapter.test.ts
    ├── mcp-client-manager.test.ts
    └── mcp-plugin.test.ts
```

核心不需要改动 — Plugin 仅依赖现有的 `WallePlugin` / `Tool` / `AgentContext`
合约。

---

## MCPPlugin

```ts
// @walle-agent/mcp

export class MCPPlugin implements WallePlugin {
  readonly name = "mcp";
  readonly version = "0.1.0";

  readonly manager: MCPClientManager;

  constructor(configs: MCPServerConfig[], options?: MCPPluginOptions) {
    this.manager = new MCPClientManager(configs, options?.factory);
  }

  async install(ctx: AgentContext): Promise<void> {
    await this.manager.connectAll();
    for (const tool of await this.manager.listTools()) {
      ctx.registerTool(tool);
    }
    // 供下游插件（权限/审计等）访问
    (ctx as any).__mcpManager = this.manager;
  }

  async dispose(): Promise<void> {
    await this.manager.disconnectAll();
  }
}
```

`install` 时完成一次性快照：连接所有 server → `listTools` → 应用白/黑名单 →
注册为内部 `Tool`。当前版本不支持运行时热重载。

---

## MCPServerConfig

```ts
export interface MCPServerConfig {
  /** 服务名称标识。用于默认前缀 `mcp_<name>_` 与 tag。 */
  name: string;

  /** Transport 配置。 */
  transport: MCPStdioTransportConfig | MCPStreamableHTTPTransportConfig;

  /** 白名单：只启用这些 MCP 工具（未命中则跳过）。 */
  enabledTools?: string[];

  /** 黑名单：禁用这些 MCP 工具。 */
  disabledTools?: string[];

  /** 工具名前缀。默认 `mcp_<name>_`，可覆盖（注意自行避免冲突）。 */
  toolPrefix?: string;

  /** 自定义 MCP Client name / version。 */
  clientName?: string;
  clientVersion?: string;
}

export interface MCPStdioTransportConfig {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface MCPStreamableHTTPTransportConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}
```

---

## MCPClientManager

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export class MCPClientManager {
  constructor(
    configs: MCPServerConfig[],
    factory?: MCPClientFactory,   // 测试注入点
  );

  connectAll(): Promise<void>;
  listTools(): Promise<Tool[]>;
  disconnectAll(): Promise<void>;   // 错误仅记录，不再抛出
  serverNames(): string[];
  getEntry(name: string): MCPClientEntry | undefined;
}
```

默认 factory 使用官方 SDK：
- `stdio` → `StdioClientTransport`
- `http`  → `StreamableHTTPClientTransport(url, { requestInit: { headers } })`

Factory seam (`MCPClientFactory`) 让单测可以注入纯内存 fake，满足
`MCPClientLike` 结构类型即可。

### 过滤规则

```ts
function includeTool(name: string, config: MCPServerConfig): boolean {
  if (config.enabledTools?.length && !config.enabledTools.includes(name)) return false;
  if (config.disabledTools?.length && config.disabledTools.includes(name)) return false;
  return true;
}
```

空数组 = 没设置该过滤器。白名单与黑名单同时存在时：工具必须在白名单内
**且** 不在黑名单内。

---

## Tool 适配

```ts
export function adaptMCPTool(opts: {
  serverName: string;
  client: MCPClientLike;
  mcpTool: MCPToolDescriptor;
  config: MCPServerConfig;
}): Tool;
```

- **name**: `${prefix}${mcpTool.name}`，默认前缀 `mcp_${serverName}_`。
- **description**: 沿用 MCP 工具描述；缺省时为 `MCP tool from <serverName>`。
- **parameters**: `mcpTool.inputSchema`；缺省时为 `{ type: "object", properties: {} }`。
- **tags**: `["mcp", serverName]`。
- **execute(input)** → `client.callTool({ name: mcpTool.name, arguments: input ?? {} })`：
  - 若 `result.content` 为数组，逐块 flatten：文本块直接拼接（`\n` 分隔），
    其它块使用 `JSON.stringify`。
  - 若 `result.content` 不存在，返回整个 result 的 `JSON.stringify`。
  - 若 `result.isError === true`，以 flatten 后的文本作为 message 抛出 `Error`，
    由 `AgentRuntime.executeToolCall` 捕获并记录 `status: "error"`。

---

## 使用示例

```ts
import { Agent } from "@walle-agent/core";
import { OpenAIProvider } from "@walle-agent/openai";
import { MCPPlugin } from "@walle-agent/mcp";

const agent = await Agent.create({
  name: "MCP-Agent",
  model: new OpenAIProvider({ model: "gpt-4.1" }),

  plugins: [
    new MCPPlugin([
      {
        name: "filesystem",
        transport: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "./workspace"],
        },
        enabledTools: ["read_file", "write_file", "list_directory"],
      },
      {
        name: "github",
        transport: {
          type: "http",
          url: "https://mcp.github.com/sse",
          headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` },
        },
      },
    ]),
  ],
});

const result = await agent.run("读取 workspace/README.md 并总结");
```

---

## 行为矩阵（关键场景）

| 场景 | 行为 |
|------|------|
| 连接失败 | `connectAll()` 抛出 → `Agent.create` 被拒绝 |
| 工具同名跨 server | 默认前缀消歧；自定义前缀造成冲突时 `ctx.registerTool` 抛出（core 原有行为） |
| `isError: true` | 适配器抛出 Error → `ToolCallRecord.status === "error"` |
| 未知 content 块类型 | `JSON.stringify` 回退 |
| `dispose` 时 close 出错 | 记录 `console.error`，继续关闭其它 client |
| `inputSchema` 缺失 | `{ type: "object", properties: {} }` |
| `description` 缺失 | `MCP tool from <serverName>` |

---

## 未来扩展（非本阶段）

- **MCP Resources → RAG**：把 `client.listResources()` 接入 `collect_context`，
  实现检索式注入。
- **MCP Prompts → Skills**：把 `client.listPrompts()` 映射为只读 Skill，
  支持被 `SkillsPlugin` 检索。
- **动态热重载**：`manager.refresh()` 重建工具列表，适配 server 侧变化。
- **OAuth / 签名请求**：HTTP transport 接入 `OAuthClientProvider`。
- **per-tool 风险等级**：配合权限插件定义 MCP 工具的 risk / approval 策略。
