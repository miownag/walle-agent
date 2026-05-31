/**
 * MCP server configuration shapes. Mirrors `docs/07-mcp.md`.
 */

export interface MCPStdioTransportConfig {
  type: "stdio";
  /** Executable to run (e.g. `npx`). */
  command: string;
  /** Arguments passed to the executable. */
  args?: string[];
  /** Env vars injected into the child process. */
  env?: Record<string, string>;
  /** Working directory for the child process. */
  cwd?: string;
}

export interface MCPStreamableHTTPTransportConfig {
  type: "http";
  /** Full URL to the MCP server endpoint. */
  url: string;
  /** Extra HTTP headers (e.g. `Authorization: Bearer …`). */
  headers?: Record<string, string>;
}

export type MCPTransportConfig =
  | MCPStdioTransportConfig
  | MCPStreamableHTTPTransportConfig;

export interface MCPServerConfig {
  /** Identifier used in the default tool prefix and in log / tag output. */
  name: string;
  /** Transport descriptor. */
  transport: MCPTransportConfig;

  /**
   * Whitelist — only MCP tools with one of these names get registered.
   * Empty or `undefined` means "no whitelist".
   */
  enabledTools?: string[];

  /**
   * Blacklist — MCP tools whose name appears here are excluded.
   * Empty or `undefined` means "no blacklist".
   */
  disabledTools?: string[];

  /**
   * Tool name prefix applied to all registered tools.
   * Default: `mcp_{serverName}_`.
   */
  toolPrefix?: string;

  /** Override the MCP client `name`. Default: `walle-agent-<serverName>`. */
  clientName?: string;
  /** Override the MCP client `version`. Default: `1.0.0`. */
  clientVersion?: string;
}
