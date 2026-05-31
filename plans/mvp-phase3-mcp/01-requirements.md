# Phase 3 — MCP Requirements

## Goal

Land the **MCP (Model Context Protocol)** slice of Phase 3 so users can configure
external MCP servers on an Agent and all exposed MCP tools become callable by
the LLM transparently.

Sandbox and Permissions are tracked separately — this branch only covers MCP.

---

## Must-Haves

1. **New package `@walle-agent/mcp`** (pnpm workspace) depending only on
   `@walle-agent/core` (peer) and `@modelcontextprotocol/sdk`.

2. **Two transports** supported by the official MCP SDK:
   - **stdio** — launch a local server as a child process.
   - **Streamable HTTP** — connect to a hosted MCP endpoint.

3. **MCPPlugin** implementing `WallePlugin`:
   - `install(ctx)` connects all configured servers, lists their tools, adapts
     each to the internal `Tool` shape and registers it via `ctx.registerTool`.
   - `dispose()` cleanly closes every client.

4. **MCPClientManager** encapsulates connection lifecycle:
   - `connectAll()` — iterate configs, create client per server, connect.
   - `listTools()` — return adapted `Tool[]` with whitelist/blacklist/prefix
     applied.
   - `disconnectAll()` — close all clients.

5. **Tool adapter** (`mcp-tool-adapter.ts`):
   - Names are prefixed (default `mcp_{serverName}_`) to avoid collisions.
   - `description` falls back when the server omits one.
   - `parameters` use the server-provided JSON Schema, or an empty object schema.
   - `execute(input)` calls `client.callTool({ name, arguments: input })` and
     flattens `content` arrays containing `{ type: "text", text }` blocks to
     a string. Non-text blocks fall back to `JSON.stringify`.
   - MCP `isError: true` responses are serialised too — the adapter re-throws so
     the core tool executor records a `status: "error"` on the `ToolCallRecord`.
   - Tags: `["mcp", serverName]`.

6. **Whitelist / blacklist**:
   - `enabledTools` — only these MCP tool names get exposed.
   - `disabledTools` — these MCP tool names are excluded.
   - Empty arrays behave like `undefined` (no filtering).

7. **Configuration surface**:
   ```ts
   new MCPPlugin([
     {
       name: "filesystem",
       transport: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "./workspace"] },
       enabledTools: ["read_file", "write_file"],
     },
     {
       name: "github",
       transport: { type: "http", url: "https://mcp.example.com/sse", headers: { Authorization: `Bearer …` } },
     },
   ]);
   ```

8. **Example**: `examples/mcp.ts` wires up a stdio filesystem server and lets
   the agent call it.

9. **Tests**: vitest coverage for:
   - Adapter: prefix, whitelist, blacklist, MCP content flattening, error
     surfacing.
   - Manager: connect + list + disconnect round trip against a mocked MCP Client.
   - Plugin: `install` registers tools; `dispose` closes clients.

## Acceptance Criteria

- [ ] `new MCPPlugin(configs)` type-checks against the core `WallePlugin` contract.
- [ ] An Agent configured with a stdio MCP server exposes the server's tools by
      the `mcp_<server>_<tool>` name in `agent.run`.
- [ ] Whitelist in config only registers the listed tools.
- [ ] Blacklist in config excludes the listed tools.
- [ ] Tool calls return the flattened text `content` as a string.
- [ ] `agent.dispose()` closes all MCP clients (no process leaks).
- [ ] MCP errors (`isError: true`) surface as tool errors without crashing the run.
- [ ] Spec docs `docs/07-mcp.md` and `docs/18-roadmap.md` updated.

---

## Non-Goals (deferred)

- **MCP Resources** as RAG sources — `collect_context` integration is a future
  phase.
- **MCP Prompts** as Skills — deferred.
- **Dynamic reconnect / reload** — tools are snapshotted at install time.
- **Auth flows** beyond setting a static `Authorization` header.
- **SSE-only transport** (legacy) — the `StreamableHTTPClientTransport` covers
  the current protocol; legacy-only servers can ship in a follow-up.
- **Sandbox and Permissions** — tracked in their own plan folders.
