# Phase 3 — MCP Testing

## Unit tests (vitest)

All tests use a hand-rolled fake implementing `MCPClientLike` + `close()` so
the suites never spawn a real MCP server.

### `tests/mcp-tool-adapter.test.ts`

- **Default naming**: adapter produces `mcp_<server>_<tool>`.
- **Custom `toolPrefix`**: honoured; adapter uses it verbatim.
- **Description fallback**: if MCP tool has no description, adapter uses
  `"MCP tool from <server>"`.
- **Parameters fallback**: missing `inputSchema` → `{ type: "object",
  properties: {} }`.
- **Tags**: `["mcp", serverName]`.
- **Content flattening (text only)**: multi-block text joined with `\n`.
- **Content flattening (mixed)**: non-text blocks serialized via
  `JSON.stringify` and concatenated.
- **Raw result**: when the MCP client returns no `content`, adapter returns
  the JSON-stringified result.
- **Error surfacing**: `isError: true` with text content → thrown `Error`
  whose message contains the flattened content.

### `tests/mcp-client-manager.test.ts`

- **Round trip**: `connectAll → listTools → disconnectAll` using a fake
  factory. Verifies:
  - `client.connect(transport)` called once per config.
  - `client.listTools()` called once per client.
  - `client.close()` called once per client.
- **Whitelist**: only listed tool names appear in `listTools()` output.
- **Blacklist**: listed tool names are removed from output.
- **Whitelist + Blacklist**: intersection semantics (must be in whitelist
  AND not in blacklist).
- **Default prefix across servers**: two servers sharing a tool name
  produce distinct registered tool names.

### `tests/mcp-plugin.test.ts`

- **`install` registers tools**: supply a `ToolRegistry`-backed
  `AgentContext`, assert each discovered tool is registered.
- **Attachment**: `ctx.__mcpManager` points to the plugin's manager.
- **`dispose` closes clients**: fake factory tracks close calls.
- **Error tolerance during close**: one client close throws; plugin still
  closes the others and does not re-throw.

---

## Integration smoke test (example)

`examples/mcp.ts` runs a real MCP stdio server
(`@modelcontextprotocol/server-filesystem`) against a scratch directory and
asks the agent to list the directory via the MCP-exposed tool. It's kept
outside the automated suite because it requires network access (`npx`
downloads the package on first run) and a configured LLM provider.

**Manual acceptance**:

1. `pnpm install`.
2. `cp examples/.env.example examples/.env` and fill API key / model.
3. `pnpm mcp`.
4. Expect the agent to invoke `mcp_filesystem_list_directory` (or similar)
   and echo the workspace listing.

---

## Coverage targets

- Adapter: 100% statement coverage is realistic — pure translation layer.
- Manager: happy path + filter branches + error-in-close path.
- Plugin: install + dispose flows.

---

## Non-goals for tests

- Spawning real stdio MCP servers in CI.
- Exercising HTTP transports against a live endpoint.
- Performance / concurrency of MCP calls.
- Protocol-level regression (covered by the upstream SDK).
