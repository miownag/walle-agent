# Phase 3 — MCP Design

## Spec references

- `docs/07-mcp.md` — MCP plugin contract.
- `docs/02-package-structure.md` — package layout.
- `docs/03-core-runtime.md` — Tool + AgentContext contracts.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│ @walle-agent/mcp                                                        │
│                                                                         │
│  MCPPlugin (WallePlugin)                                                │
│   ├── install(ctx)                                                      │
│   │     ├─► MCPClientManager.connectAll()                               │
│   │     ├─► MCPClientManager.listTools()                                │
│   │     └─► ctx.registerTool(t)  for each adapted tool                  │
│   └── dispose()                                                         │
│         └─► MCPClientManager.disconnectAll()                            │
│                                                                         │
│  MCPClientManager                                                       │
│   ├── clients: Map<serverName, { client: Client, config }>              │
│   ├── connectAll(): create Client + Transport per config, connect()     │
│   ├── listTools(): for each client → client.listTools() → adapt → filter│
│   └── disconnectAll(): close every client                               │
│                                                                         │
│  adaptMCPTool(serverName, client, mcpTool, config) → Tool               │
│   ├── name:         `${prefix}${mcpTool.name}`                          │
│   ├── description:  mcpTool.description ?? fallback                     │
│   ├── parameters:   mcpTool.inputSchema ?? { type: "object", properties }│
│   ├── tags:         ["mcp", serverName]                                 │
│   └── execute():    client.callTool({ name, arguments })                │
│                      → flatten content[] → string                        │
│                      → throw on isError: true                           │
└────────────────────────────────────────────────────────────────────────┘
```

No changes to `@walle-agent/core` are required.

---

## Package layout

```
packages/mcp/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── src/
│   ├── index.ts                 # public API re-exports
│   ├── mcp-plugin.ts            # WallePlugin impl
│   ├── mcp-client-manager.ts    # connection lifecycle + listing
│   ├── mcp-tool-adapter.ts      # MCP Tool → internal Tool
│   └── mcp-config.ts            # MCPServerConfig + transport types
└── tests/
    ├── mcp-tool-adapter.test.ts
    ├── mcp-client-manager.test.ts
    └── mcp-plugin.test.ts
```

---

## Data shapes

```ts
// mcp-config.ts

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

export type MCPTransportConfig =
  | MCPStdioTransportConfig
  | MCPStreamableHTTPTransportConfig;

export interface MCPServerConfig {
  name: string;
  transport: MCPTransportConfig;
  /** Whitelist — only these tools get registered. Empty ⇒ no whitelist. */
  enabledTools?: string[];
  /** Blacklist — these tools are excluded. Empty ⇒ no blacklist. */
  disabledTools?: string[];
  /** Tool name prefix. Default `mcp_{serverName}_`. */
  toolPrefix?: string;
  /** Client identity (defaults to `walle-agent-<serverName>`). */
  clientName?: string;
  clientVersion?: string;
}
```

---

## Tool adapter contract

```ts
// mcp-tool-adapter.ts

import type { Tool } from "@walle-agent/core";

/**
 * Minimal structural types for the pieces of the MCP SDK we depend on.
 * Kept narrow so the adapter is easy to unit-test with a hand-rolled fake.
 */
export interface MCPToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface MCPToolCallResult {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
  [k: string]: unknown;
}

export interface MCPClientLike {
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<MCPToolCallResult>;
}

export function adaptMCPTool(opts: {
  serverName: string;
  client: MCPClientLike;
  mcpTool: MCPToolDescriptor;
  config: MCPServerConfig;
}): Tool;
```

### Output flattening

```
content = [{type:"text", text:"A"}, {type:"text", text:"B"}, {type:"image", …}]
         → "A\nB\n{\"type\":\"image\", …}"
```

If `content` is absent, the raw result is stringified via `JSON.stringify`.

### Error surfacing

`isError === true` means the MCP tool wants the LLM to see a failure. We throw
an `Error` whose message is the flattened content so that
`AgentRuntime.executeToolCall` catches it and records a `status: "error"` on the
`ToolCallRecord`. This keeps MCP tools behaviourally identical to native tools
that throw.

---

## Manager contract

```ts
// mcp-client-manager.ts

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface MCPClientFactory {
  create(config: MCPServerConfig): { client: Client; transport: unknown };
}

export class MCPClientManager {
  constructor(
    private readonly configs: MCPServerConfig[],
    private readonly factory: MCPClientFactory = defaultFactory,
  ) {}

  async connectAll(): Promise<void>;
  async listTools(): Promise<Tool[]>;
  async disconnectAll(): Promise<void>;
}
```

The `factory` seam lets tests substitute a fake `Client` that implements the
narrow `MCPClientLike` surface (`listTools` + `callTool` + `close`).

---

## Plugin contract

```ts
// mcp-plugin.ts

export class MCPPlugin implements WallePlugin {
  readonly name = "mcp";
  readonly version = "0.1.0";

  readonly manager: MCPClientManager;

  constructor(configs: MCPServerConfig[], options?: { factory?: MCPClientFactory });

  async install(ctx: AgentContext): Promise<void>;
  async dispose(): Promise<void>;
}
```

`install` does `connectAll → listTools → registerTool(..)` and then stashes
`ctx.__mcpManager = manager` so future plugins (e.g. a future permissions
plugin that wants to whitelist MCP tools) can reach it, following the same
attachment pattern used by Memory / Skills.

`dispose` calls `manager.disconnectAll`. Errors during close are logged and
swallowed (matching the rest of the SDK — `dispose` must be robust).

---

## Control flow (happy path)

```
Agent.create({ plugins: [new MCPPlugin([...])] })
   │
   ▼
plugin.install(ctx)
   │
   ├─ manager.connectAll()
   │     for each config:
   │        const transport = create(config.transport)
   │        const client = new Client({ name, version })
   │        await client.connect(transport)
   │        clients.set(name, { client, config })
   │
   └─ manager.listTools()
         for each (serverName, client):
            const { tools } = await client.listTools()
            for each t in tools:
               if !whitelisted or blacklisted → skip
               ctx.registerTool(adaptMCPTool(...))
```

---

## Error & edge-case policy

| Case | Behaviour |
|------|-----------|
| Server fails to connect | `connectAll` throws — `Agent.create` rejects. User gets a clear error. |
| Whitelist is empty `[]` | Interpreted as "no whitelist" (behaves like `undefined`). |
| Both lists set | Whitelist wins (entry must be in whitelist *and* not in blacklist). |
| Duplicate tool names across servers | Default prefix disambiguates. If user overrides `toolPrefix` and creates a clash, `ctx.registerTool` throws (existing core behaviour). |
| MCP returns `isError: true` | Adapter throws → runtime records `status: "error"`. |
| MCP returns unknown content blocks | Stringified with `JSON.stringify`. |
| `dispose` close error | Logged via `console.error`, never rethrown. |
| Missing `inputSchema` | Use `{ type: "object", properties: {} }`. |
| Missing `description` | Fallback to `MCP tool from <serverName>`. |

---

## Key design decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Snapshot tools at install time | Yes | MCP servers rarely advertise new tools mid-session; keeps runtime simple and matches spec. |
| Adapter seam for testing | `MCPClientLike` structural interface | Decouples tests from heavy SDK client. |
| Error via throw | Yes | Lines up with core tool executor's catch-and-record path. |
| Prefix default | `mcp_<serverName>_` | Prevents collisions, keeps names grep-able in traces. |
| Plugin attachment field | `ctx.__mcpManager` | Matches Memory / Skills precedent. |
| No `collect_context` integration | Deferred | RAG-style resource injection is its own feature. |
| No dynamic reconnect | Deferred | Adds complexity for marginal benefit in MVP. |

---

## File inventory (this branch)

**New package**

- `packages/mcp/**` — full plugin (as laid out above).

**Modified**

- Root `package.json` — no script needed (example drives it).
- `examples/package.json` — add `@walle-agent/mcp` dep + `mcp` script.
- `examples/mcp.ts` — new example.
- `docs/07-mcp.md` — tighten to reflect shipped surface (no behavioural diff).
- `docs/18-roadmap.md` — tick Phase 3 MCP acceptance lines.
- `docs/INDEX.md` — unchanged (MCP already listed).

---

## Follow-ups (out of scope)

- MCP Resources → RAG `collect_context` source.
- MCP Prompts → Skills bridge.
- Dynamic server reload (`manager.refresh()`).
- OAuth / signed request flows for HTTP transport.
- SSE-only legacy transport.
- Per-tool permission / risk-level policy.
