/**
 * MCPClientManager — owns the lifecycle of one Client per configured server
 * and exposes their tools as internal `Tool` instances.
 *
 * The heavy lifting (spawning a child process, negotiating the MCP handshake,
 * shuttling JSON-RPC messages) is delegated to the official
 * `@modelcontextprotocol/sdk` client. We only keep a structural seam
 * (`MCPClientFactory`) so tests can inject a fake without needing the full
 * SDK.
 */

import type { Tool } from "@walle-agent/core";
import type {
  MCPServerConfig,
  MCPStdioTransportConfig,
  MCPStreamableHTTPTransportConfig,
} from "./mcp-config.js";
import {
  adaptMCPTool,
  type MCPClientLike,
  type MCPToolDescriptor,
} from "./mcp-tool-adapter.js";

// ─── Minimal structural type for an MCP client ────────────────────────────

export interface ManagedMCPClient extends MCPClientLike {
  connect(transport: unknown, options?: MCPRequestOptions): Promise<void>;
  listTools(params?: unknown, options?: MCPRequestOptions): Promise<{ tools: MCPToolDescriptor[] }>;
  close(): Promise<void>;
}

export interface MCPRequestOptions {
  signal?: AbortSignal;
  timeout?: number;
  maxTotalTimeout?: number;
}

export interface MCPClientEntry {
  client: ManagedMCPClient;
  transport: unknown;
  config: MCPServerConfig;
  /** Internal lifecycle marker; consumers should treat entries as read-only. */
  closed?: boolean;
}

export interface MCPClientFactory {
  create(config: MCPServerConfig, options?: { signal?: AbortSignal }): {
    client: ManagedMCPClient;
    transport: unknown;
  } | Promise<{
    client: ManagedMCPClient;
    transport: unknown;
  }>;
}

export interface MCPClientManagerOptions {
  /** Abort initialization, including a pending stdio handshake. */
  signal?: AbortSignal;
  /** Per-server client creation + handshake timeout. Default: 30 seconds. */
  connectTimeoutMs?: number;
  /** Per-server tool discovery timeout. Default: 15 seconds. */
  listToolsTimeoutMs?: number;
  /** Per-tool request timeout. Default: 60 seconds. */
  toolCallTimeoutMs?: number;
  /** Maximum time to wait for a client/transport close. Default: 5 seconds. */
  closeTimeoutMs?: number;
  /** Notifies owners that the Agent runtime should be rebuilt. */
  onClientInvalidated?: (serverName: string, reason: unknown) => void;
}

// ─── Default factory (uses the real MCP SDK) ──────────────────────────────

async function defaultFactoryCreate(config: MCPServerConfig): Promise<{
  client: ManagedMCPClient;
  transport: unknown;
}> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const transport = await createDefaultTransport(config);
  const client = new Client({
    name: config.clientName ?? `walle-agent-${config.name}`,
    version: config.clientVersion ?? "1.0.0",
  });
  return { client: client as unknown as ManagedMCPClient, transport };
}

async function createDefaultTransport(config: MCPServerConfig): Promise<unknown> {
  switch (config.transport.type) {
    case "stdio": {
      const t = config.transport as MCPStdioTransportConfig;
      const { StdioClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/stdio.js"
      );
      return new StdioClientTransport({
        command: t.command,
        args: t.args ?? [],
        env: t.env,
        cwd: t.cwd,
      });
    }
    case "http": {
      const t = config.transport as MCPStreamableHTTPTransportConfig;
      const { StreamableHTTPClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/streamableHttp.js"
      );
      return new StreamableHTTPClientTransport(new URL(t.url), {
        requestInit: t.headers ? { headers: t.headers } : undefined,
      });
    }
    default: {
      const exhaustive: never = config.transport;
      throw new Error(
        `Unsupported MCP transport: ${(exhaustive as { type?: string })?.type}`,
      );
    }
  }
}

export const defaultMCPClientFactory: MCPClientFactory = {
  create(_config: MCPServerConfig) {
    // The default factory is async under the hood but `create` is declared
    // sync to match the structural interface. We return a "deferred" pair
    // wrapped in a harness that awaits the real create on first use.
    //
    // In practice `connectAll` is the only caller and it `await`s everything,
    // so we take a simpler route: expose a sync wrapper that throws if the
    // SDK isn't loaded, and let `MCPClientManager` route through an internal
    // async path. This keeps the public factory interface simple for tests.
    throw new Error(
      "defaultMCPClientFactory.create() is a placeholder — `MCPClientManager` uses its internal async bootstrap when no factory is supplied.",
    );
  },
};

// ─── Manager ──────────────────────────────────────────────────────────────

export class MCPClientManager {
  private readonly entries = new Map<string, MCPClientEntry>();
  private readonly lifetime = new AbortController();
  private readonly options: Required<Pick<MCPClientManagerOptions, "connectTimeoutMs" | "listToolsTimeoutMs" | "toolCallTimeoutMs" | "closeTimeoutMs">>;
  private readonly onClientInvalidated?: MCPClientManagerOptions["onClientInvalidated"];
  private readonly externalSignal?: AbortSignal;
  private readonly forwardExternalAbort: () => void;
  private connected = false;
  private connecting?: Promise<void>;

  constructor(
    private readonly configs: MCPServerConfig[],
    private readonly factory?: MCPClientFactory,
    options: MCPClientManagerOptions = {},
  ) {
    this.options = {
      connectTimeoutMs: positiveTimeout(options.connectTimeoutMs, 30_000),
      listToolsTimeoutMs: positiveTimeout(options.listToolsTimeoutMs, 15_000),
      toolCallTimeoutMs: positiveTimeout(options.toolCallTimeoutMs, 60_000),
      closeTimeoutMs: positiveTimeout(options.closeTimeoutMs, 5_000),
    };
    this.onClientInvalidated = options.onClientInvalidated;
    this.externalSignal = options.signal;
    this.forwardExternalAbort = () => {
      if (!this.lifetime.signal.aborted) {
        this.lifetime.abort(this.externalSignal?.reason ?? new DOMException("MCP initialization cancelled", "AbortError"));
      }
    };
    if (this.externalSignal?.aborted) this.forwardExternalAbort();
    else this.externalSignal?.addEventListener("abort", this.forwardExternalAbort, { once: true });
  }

  /** Snapshot of currently-registered server names. */
  serverNames(): string[] {
    return [...this.entries.keys()];
  }

  /** Access a connected entry by server name (mainly for tests). */
  getEntry(name: string): MCPClientEntry | undefined {
    return this.entries.get(name);
  }

  async connectAll(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    const operation = this.connectAllInternal();
    this.connecting = operation;
    try {
      await operation;
    } finally {
      if (this.connecting === operation) this.connecting = undefined;
    }
  }

  async listTools(): Promise<Tool[]> {
    const result: Tool[] = [];
    const registeredNames = new Map<string, string>();

    for (const [serverName, entry] of this.entries) {
      let response: { tools: MCPToolDescriptor[] };
      try {
        response = await this.runBounded(
          `MCP server “${serverName}” tool discovery`,
          this.options.listToolsTimeoutMs,
          (signal) => entry.client.listTools(undefined, {
            signal,
            timeout: this.options.listToolsTimeoutMs,
            maxTotalTimeout: this.options.listToolsTimeoutMs,
          }),
        );
      } catch (error) {
        await this.invalidateEntry(serverName, entry, error);
        throw error;
      }
      const tools = Array.isArray(response?.tools) ? response.tools : [];

      for (const mcpTool of tools) {
        if (!includeTool(mcpTool.name, entry.config)) continue;
        const adapted = adaptMCPTool({
          serverName,
          client: entry.client,
          mcpTool,
          config: entry.config,
          callTimeoutMs: this.options.toolCallTimeoutMs,
          onUnresponsive: (reason) => this.invalidateEntry(serverName, entry, reason),
        });
        const source = `${serverName}:${mcpTool.name}`;
        const previous = registeredNames.get(adapted.name);
        if (previous) {
          throw new Error(`MCP tool name collision after provider-safe normalization: ${previous} and ${source} both map to ${adapted.name}`);
        }
        registeredNames.set(adapted.name, source);
        result.push(adapted);
      }
    }

    return result;
  }

  async disconnectAll(): Promise<void> {
    if (!this.lifetime.signal.aborted) {
      this.lifetime.abort(new DOMException("MCP manager disconnected", "AbortError"));
    }
    this.externalSignal?.removeEventListener("abort", this.forwardExternalAbort);
    const errors: unknown[] = [];
    for (const entry of this.entries.values()) {
      try {
        await this.closeEntry(entry);
      } catch (err) {
        errors.push(err);
      }
    }
    this.entries.clear();
    this.connected = false;

    if (errors.length) {
      for (const err of errors) {
        // Preserve the "never throw during dispose" contract but still surface
        // failures for debugging.
        console.error("[mcp] error during client.close():", err);
      }
    }
  }

  // ─── internals ──────────────────────────────────────────────────────────

  private async connectAllInternal(): Promise<void> {
    const names = new Set<string>();
    for (const config of this.configs) {
      if (names.has(config.name)) throw new Error(`Duplicate MCP server name: ${config.name}`);
      names.add(config.name);
    }

    try {
      for (const config of this.configs) {
        const { client, transport } = await this.runBounded(
          `MCP server “${config.name}” client creation`,
          this.options.connectTimeoutMs,
          (signal) => {
            const created = Promise.resolve(this.createClient(config, signal));
            // A factory may ignore cancellation and resolve after our deadline.
            // Close that detached client as soon as it becomes reachable.
            void created.then((late) => {
              if (!signal.aborted) return;
              const detached: MCPClientEntry = { ...late, config };
              void this.closeEntry(detached).catch((error) => {
                // eslint-disable-next-line no-console
                console.error(`[mcp] failed to close late client for ${config.name}:`, error);
              });
            }, () => undefined);
            return created;
          },
        );
        // Register before connect so an abort/timeout can always reach close(),
        // including stdio transports whose child is spawned during handshake.
        const entry: MCPClientEntry = { client, transport, config };
        this.entries.set(config.name, entry);
        await this.runBounded(
          `MCP server “${config.name}” connection`,
          this.options.connectTimeoutMs,
          (signal) => client.connect(transport, {
            signal,
            timeout: this.options.connectTimeoutMs,
            maxTotalTimeout: this.options.connectTimeoutMs,
          }),
        );
      }
      this.connected = true;
    } catch (error) {
      await this.disconnectAll();
      throw error;
    }
  }

  private async runBounded<T>(
    label: string,
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<T> | T,
  ): Promise<T> {
    if (this.lifetime.signal.aborted) throw abortError(label, this.lifetime.signal.reason);
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(this.lifetime.signal.reason);
    this.lifetime.signal.addEventListener("abort", forwardAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutError = new Error(`${label} timed out after ${timeoutMs}ms`);
    timeoutError.name = "TimeoutError";
    timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
    timer.unref?.();
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(abortError(label, controller.signal.reason)), { once: true });
    });
    try {
      return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), aborted]);
    } finally {
      if (timer) clearTimeout(timer);
      this.lifetime.signal.removeEventListener("abort", forwardAbort);
    }
  }

  private async closeEntry(entry: MCPClientEntry): Promise<void> {
    if (entry.closed) return;
    entry.closed = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(
        `MCP server “${entry.config.name}” did not close within ${this.options.closeTimeoutMs}ms`,
      )), this.options.closeTimeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([entry.client.close(), timedOut]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async invalidateEntry(serverName: string, entry: MCPClientEntry, reason: unknown): Promise<void> {
    try {
      await this.closeEntry(entry);
    } finally {
      if (this.entries.get(serverName) === entry) this.entries.delete(serverName);
      this.connected = false;
      this.onClientInvalidated?.(serverName, reason);
    }
  }

  private async createClient(config: MCPServerConfig, signal: AbortSignal): Promise<{
    client: ManagedMCPClient;
    transport: unknown;
  }> {
    if (this.factory) {
      return this.factory.create(config, { signal });
    }
    return defaultFactoryCreate(config);
  }
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function abortError(label: string, reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error(`${label} cancelled${typeof reason === "string" ? `: ${reason}` : ""}`);
  error.name = "AbortError";
  return error;
}

// ─── Filters ──────────────────────────────────────────────────────────────

function hasEntries(list: string[] | undefined): list is string[] {
  return Array.isArray(list) && list.length > 0;
}

export function includeTool(
  toolName: string,
  config: MCPServerConfig,
): boolean {
  if (hasEntries(config.enabledTools) && !config.enabledTools.includes(toolName)) {
    return false;
  }
  if (hasEntries(config.disabledTools) && config.disabledTools.includes(toolName)) {
    return false;
  }
  return true;
}
