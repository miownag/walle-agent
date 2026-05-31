/**
 * @walle-agent/mcp — public API.
 */

export { MCPPlugin } from "./mcp-plugin.js";
export type { MCPPluginOptions } from "./mcp-plugin.js";

export {
  MCPClientManager,
  defaultMCPClientFactory,
  includeTool,
} from "./mcp-client-manager.js";
export type {
  MCPClientFactory,
  MCPClientEntry,
  ManagedMCPClient,
} from "./mcp-client-manager.js";

export { adaptMCPTool, flattenMCPResult } from "./mcp-tool-adapter.js";
export type {
  AdaptMCPToolOptions,
  MCPClientLike,
  MCPContentBlock,
  MCPToolCallResult,
  MCPToolDescriptor,
} from "./mcp-tool-adapter.js";

export type {
  MCPServerConfig,
  MCPTransportConfig,
  MCPStdioTransportConfig,
  MCPStreamableHTTPTransportConfig,
} from "./mcp-config.js";
