# Phase 3 — MCP Tasks

Ordered implementation checklist. Items without a checkbox are informational.

## 1. Scaffold package

- [ ] Create `packages/mcp/` with `package.json`, `tsconfig.json`, `tsup.config.ts`.
- [ ] Declare `@walle-agent/core` as peer/dev-dependency.
- [ ] Declare `@modelcontextprotocol/sdk` as `dependencies`.
- [ ] Mirror the `skills` package scaffolding (ESM, dual build, `dist/` output).
- [ ] `pnpm install` from repo root to register the new workspace package.

## 2. Config types

- [ ] `src/mcp-config.ts`:
  - [ ] `MCPStdioTransportConfig`, `MCPStreamableHTTPTransportConfig`, union
        `MCPTransportConfig`.
  - [ ] `MCPServerConfig` with `name`, `transport`, `enabledTools?`,
        `disabledTools?`, `toolPrefix?`, `clientName?`, `clientVersion?`.

## 3. Tool adapter

- [ ] `src/mcp-tool-adapter.ts`:
  - [ ] Structural types `MCPToolDescriptor`, `MCPToolCallResult`,
        `MCPClientLike`.
  - [ ] `adaptMCPTool({ serverName, client, mcpTool, config })` returning
        a `Tool`.
  - [ ] Name uses `config.toolPrefix ?? \`mcp_${serverName}_\``.
  - [ ] `description` fallback, `parameters` fallback, tags
        `["mcp", serverName]`.
  - [ ] `execute` calls `client.callTool({ name, arguments })`.
  - [ ] Flatten `content` array: text → concat with `\n`, otherwise JSON-string.
  - [ ] `isError === true` ⇒ throw with the flattened message.

## 4. Client manager

- [ ] `src/mcp-client-manager.ts`:
  - [ ] Default factory: creates `Client` + `StdioClientTransport` /
        `StreamableHTTPClientTransport` depending on `config.transport.type`.
  - [ ] `connectAll()` iterates configs, awaits `client.connect(transport)`.
  - [ ] `listTools()` awaits `client.listTools()` and runs each through
        `adaptMCPTool`, applying enabled/disabled filters.
  - [ ] `disconnectAll()` iterates clients, awaits `client.close()`. Errors
        logged, not rethrown.
  - [ ] Exported factory seam `MCPClientFactory` for tests.

## 5. Plugin

- [ ] `src/mcp-plugin.ts`:
  - [ ] `MCPPlugin implements WallePlugin` with `name = "mcp"`.
  - [ ] Constructor takes `configs` + optional `{ factory }`.
  - [ ] `install(ctx)`:
    - [ ] `await manager.connectAll()`.
    - [ ] For each tool in `manager.listTools()` → `ctx.registerTool(tool)`.
    - [ ] Stash `ctx.__mcpManager = manager`.
  - [ ] `dispose()` → `manager.disconnectAll()`.

## 6. Public API

- [ ] `src/index.ts`:
  - [ ] Re-export `MCPPlugin`, `MCPClientManager`, config types,
        `adaptMCPTool`, `MCPClientFactory`, `MCPClientLike`.

## 7. Tests

- [ ] `tests/mcp-tool-adapter.test.ts`:
  - [ ] name/description/parameters defaults.
  - [ ] prefix override.
  - [ ] content flattening (text, mixed, empty).
  - [ ] `isError === true` ⇒ thrown error.
- [ ] `tests/mcp-client-manager.test.ts`:
  - [ ] Fake factory — verify connect / listTools / disconnect round trip.
  - [ ] Whitelist filter applied.
  - [ ] Blacklist filter applied.
  - [ ] Both lists — intersection behaviour.
- [ ] `tests/mcp-plugin.test.ts`:
  - [ ] `install` registers all discovered tools on a `ToolRegistry`.
  - [ ] `dispose` calls `client.close()` for every server.

## 8. Example

- [ ] `examples/mcp.ts` — stdio filesystem server example.
- [ ] `examples/package.json` — add `@walle-agent/mcp` dep + `mcp` script.
- [ ] Root `package.json` — add `pnpm mcp` shortcut script.

## 9. Spec updates

- [ ] `docs/07-mcp.md` — align wording (content flattening, error surfacing,
      `ctx.__mcpManager`).
- [ ] `docs/18-roadmap.md` — tick Phase 3 MCP acceptance boxes.
- [ ] `plans/README.md` — list new plan folder (if convention requires).

## 10. Verification

- [ ] `pnpm build` green across the workspace.
- [ ] `pnpm test` passes including the new MCP suites.
- [ ] `pnpm mcp` (example) starts the stdio MCP server and the agent calls a
      tool from it end to end.
