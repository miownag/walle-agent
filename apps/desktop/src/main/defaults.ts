import type {
  AppSettings,
  CapabilityStatus,
  DeepPartial,
  ProviderProfile,
} from "../shared/contracts";

export const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  appearance: {
    theme: "system",
    density: "comfortable",
    fontSize: 13,
    codeFontSize: 12,
    reduceMotion: false,
  },
  sandbox: {
    kind: "local",
    timeoutMs: 120_000,
    allowedCommands: [],
    dockerImage: "node:22-bookworm",
    dockerMemory: "2g",
    dockerCpus: 2,
    dockerNetwork: "none",
  },
  permissions: {
    mode: "ask",
    approveFileWrites: true,
    approveShell: true,
    approveNetwork: true,
    approveHighRisk: true,
    alwaysAllowTools: [],
    denyTools: [],
  },
  capabilities: {
    memory: true,
    skills: true,
    evolution: false,
    rag: false,
    mcp: false,
    team: true,
    trace: true,
    macroCompression: true,
    toolSearch: true,
    evolutionEveryTurns: 10,
    evolutionMinToolCalls: 5,
    ragDirectory: "",
    recordTraceContent: false,
  },
  providers: [],
  mcpServers: [],
  userSkillsDirectory: "~/.agents",
  defaultSystemPrompt: [
    "You are Walle, a local coding agent working inside the selected workspace.",
    "Inspect the code before changing it, keep edits scoped, use the sandboxed shell tool instead of bash, and verify meaningful changes.",
  ].join(" "),
  maxTurns: 24,
  maxContextTokens: 256_000,
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function boolValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function finiteNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && values.includes(value as T)
    ? (value as T)
    : fallback;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function normalizeProviders(value: unknown): ProviderProfile[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const providers: ProviderProfile[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const id = stringValue(candidate.id, "").trim();
    const name = stringValue(candidate.name, "").trim();
    const model = stringValue(candidate.model, "").trim();
    if (!id || !name || !model || seen.has(id)) continue;
    seen.add(id);
    providers.push({
      id,
      name,
      kind: enumValue(
        candidate.kind,
        ["openai", "openai-compatible", "anthropic"] as const,
        "openai",
      ),
      model,
      baseUrl:
        typeof candidate.baseUrl === "string" && candidate.baseUrl.trim()
          ? candidate.baseUrl.trim()
          : undefined,
      hasApiKey: boolValue(candidate.hasApiKey, false),
      apiKeyHint:
        typeof candidate.apiKeyHint === "string"
          ? candidate.apiKeyHint
          : undefined,
      isDefault: boolValue(candidate.isDefault, false),
    });
  }
  const defaultIndex = providers.findIndex((provider) => provider.isDefault);
  providers.forEach((provider, index) => {
    provider.isDefault = index === (defaultIndex >= 0 ? defaultIndex : 0);
  });
  return providers;
}

export function normalizeSettings(value: unknown): AppSettings {
  const root = isRecord(value) ? value : {};
  const appearance = isRecord(root.appearance) ? root.appearance : {};
  const sandbox = isRecord(root.sandbox) ? root.sandbox : {};
  const permissions = isRecord(root.permissions) ? root.permissions : {};
  const capabilities = isRecord(root.capabilities) ? root.capabilities : {};

  const mcpServers = Array.isArray(root.mcpServers)
    ? root.mcpServers.flatMap((candidate) => {
        if (!isRecord(candidate)) return [];
        const id = stringValue(candidate.id, "").trim();
        const name = stringValue(candidate.name, "").trim();
        if (!id || !name) return [];
        const transport = enumValue(
          candidate.transport,
          ["stdio", "http"] as const,
          "stdio",
        );
        return [
          {
            id,
            name,
            enabled: boolValue(candidate.enabled, true),
            transport,
            command:
              typeof candidate.command === "string"
                ? candidate.command
                : undefined,
            args: stringArray(candidate.args),
            cwd: typeof candidate.cwd === "string" ? candidate.cwd : undefined,
            url: typeof candidate.url === "string" ? candidate.url : undefined,
            headers: isRecord(candidate.headers)
              ? Object.fromEntries(
                  Object.entries(candidate.headers).filter(
                    (entry): entry is [string, string] =>
                      typeof entry[1] === "string",
                  ),
                )
              : undefined,
          },
        ];
      })
    : [];

  const result: AppSettings = {
    version: 1,
    appearance: {
      theme: enumValue(
        appearance.theme,
        ["system", "light", "dark"] as const,
        DEFAULT_SETTINGS.appearance.theme,
      ),
      density: enumValue(
        appearance.density,
        ["comfortable", "compact"] as const,
        DEFAULT_SETTINGS.appearance.density,
      ),
      fontSize: finiteNumber(
        appearance.fontSize,
        DEFAULT_SETTINGS.appearance.fontSize,
        10,
        24,
      ),
      codeFontSize: finiteNumber(
        appearance.codeFontSize,
        DEFAULT_SETTINGS.appearance.codeFontSize,
        9,
        24,
      ),
      reduceMotion: boolValue(
        appearance.reduceMotion,
        DEFAULT_SETTINGS.appearance.reduceMotion,
      ),
    },
    sandbox: {
      kind: enumValue(
        sandbox.kind,
        ["local", "docker"] as const,
        DEFAULT_SETTINGS.sandbox.kind,
      ),
      timeoutMs: finiteNumber(
        sandbox.timeoutMs,
        DEFAULT_SETTINGS.sandbox.timeoutMs,
        1_000,
        30 * 60_000,
      ),
      allowedCommands: stringArray(sandbox.allowedCommands),
      dockerImage: stringValue(
        sandbox.dockerImage,
        DEFAULT_SETTINGS.sandbox.dockerImage,
      ),
      dockerMemory: stringValue(
        sandbox.dockerMemory,
        DEFAULT_SETTINGS.sandbox.dockerMemory,
      ),
      dockerCpus: finiteNumber(
        sandbox.dockerCpus,
        DEFAULT_SETTINGS.sandbox.dockerCpus,
        0.1,
        64,
      ),
      dockerNetwork: enumValue(
        sandbox.dockerNetwork,
        ["none", "bridge", "host"] as const,
        DEFAULT_SETTINGS.sandbox.dockerNetwork,
      ),
    },
    permissions: {
      mode: enumValue(
        permissions.mode,
        ["auto", "ask", "deny-high-risk"] as const,
        DEFAULT_SETTINGS.permissions.mode,
      ),
      approveFileWrites: boolValue(
        permissions.approveFileWrites,
        DEFAULT_SETTINGS.permissions.approveFileWrites,
      ),
      approveShell: boolValue(
        permissions.approveShell,
        DEFAULT_SETTINGS.permissions.approveShell,
      ),
      approveNetwork: boolValue(
        permissions.approveNetwork,
        DEFAULT_SETTINGS.permissions.approveNetwork,
      ),
      approveHighRisk: boolValue(
        permissions.approveHighRisk,
        DEFAULT_SETTINGS.permissions.approveHighRisk,
      ),
      alwaysAllowTools: stringArray(permissions.alwaysAllowTools),
      denyTools: stringArray(permissions.denyTools),
    },
    capabilities: {
      memory: boolValue(
        capabilities.memory,
        DEFAULT_SETTINGS.capabilities.memory,
      ),
      skills: boolValue(
        capabilities.skills,
        DEFAULT_SETTINGS.capabilities.skills,
      ),
      evolution: boolValue(
        capabilities.evolution,
        DEFAULT_SETTINGS.capabilities.evolution,
      ),
      rag: boolValue(capabilities.rag, DEFAULT_SETTINGS.capabilities.rag),
      mcp: boolValue(capabilities.mcp, DEFAULT_SETTINGS.capabilities.mcp),
      team: boolValue(capabilities.team, DEFAULT_SETTINGS.capabilities.team),
      trace: boolValue(capabilities.trace, DEFAULT_SETTINGS.capabilities.trace),
      macroCompression: boolValue(
        capabilities.macroCompression,
        DEFAULT_SETTINGS.capabilities.macroCompression,
      ),
      toolSearch: boolValue(
        capabilities.toolSearch,
        DEFAULT_SETTINGS.capabilities.toolSearch,
      ),
      evolutionEveryTurns: finiteNumber(
        capabilities.evolutionEveryTurns,
        DEFAULT_SETTINGS.capabilities.evolutionEveryTurns,
        1,
        10_000,
      ),
      evolutionMinToolCalls: finiteNumber(
        capabilities.evolutionMinToolCalls,
        DEFAULT_SETTINGS.capabilities.evolutionMinToolCalls,
        1,
        1_000,
      ),
      ragDirectory: stringValue(
        capabilities.ragDirectory,
        DEFAULT_SETTINGS.capabilities.ragDirectory,
      ),
      recordTraceContent: boolValue(
        capabilities.recordTraceContent,
        DEFAULT_SETTINGS.capabilities.recordTraceContent,
      ),
    },
    providers: normalizeProviders(root.providers),
    mcpServers,
    userSkillsDirectory: stringValue(
      root.userSkillsDirectory,
      DEFAULT_SETTINGS.userSkillsDirectory,
    ),
    defaultSystemPrompt: stringValue(
      root.defaultSystemPrompt,
      DEFAULT_SETTINGS.defaultSystemPrompt,
    ),
    maxTurns: finiteNumber(root.maxTurns, DEFAULT_SETTINGS.maxTurns, 1, 200),
    maxContextTokens: finiteNumber(
      root.maxContextTokens,
      DEFAULT_SETTINGS.maxContextTokens,
      4_096,
      2_000_000,
    ),
  };
  // Evolution's engine requires the Memory manager as its durable apply
  // target. Keep this dependency explicit instead of constructing a partially
  // functional Evolution plugin.
  if (result.capabilities.evolution) result.capabilities.memory = true;
  return result;
}

function mergeValue(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base;
  if (Array.isArray(patch)) return patch;
  if (!isRecord(base) || !isRecord(patch)) return patch;
  const result: JsonRecord = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    result[key] = mergeValue(result[key], value);
  }
  return result;
}

export function mergeSettings(
  settings: AppSettings,
  patch: DeepPartial<AppSettings>,
): AppSettings {
  return normalizeSettings(mergeValue(settings, patch));
}

export function capabilityStatuses(settings: AppSettings): CapabilityStatus[] {
  const enabledServers = settings.mcpServers.filter(
    (server) => server.enabled,
  ).length;
  const readyProviders = settings.providers.filter(
    (provider) => provider.hasApiKey,
  ).length;
  return [
    {
      id: "providers",
      label: "Providers",
      enabled: true,
      status: readyProviders ? "ready" : "attention",
      detail: readyProviders
        ? `${readyProviders} configured profile${readyProviders === 1 ? "" : "s"}`
        : "Add a Provider API key",
    },
    {
      id: "memory",
      label: "Memory",
      enabled: settings.capabilities.memory,
      status: settings.capabilities.memory ? "ready" : "disabled",
      detail: settings.capabilities.memory
        ? "Local session and long-term memory"
        : "Disabled in settings",
    },
    {
      id: "skills",
      label: "Skills",
      enabled: settings.capabilities.skills,
      status: settings.capabilities.skills ? "ready" : "disabled",
      detail: settings.capabilities.skills
        ? "Project and user skill catalogs"
        : "Disabled in settings",
    },
    {
      id: "evolution",
      label: "Evolution",
      enabled: settings.capabilities.evolution,
      status: settings.capabilities.evolution ? "ready" : "disabled",
      detail: settings.capabilities.evolution
        ? "Human-reviewed local proposals"
        : "Disabled in settings",
    },
    {
      id: "sandbox",
      label: "Sandbox",
      enabled: true,
      status: "ready",
      detail:
        settings.sandbox.kind === "docker"
          ? "Docker container boundary"
          : "Local host process (not isolated)",
    },
    {
      id: "rag",
      label: "RAG",
      enabled: settings.capabilities.rag,
      status: settings.capabilities.rag
        ? settings.capabilities.ragDirectory
          ? "ready"
          : "attention"
        : "disabled",
      detail: settings.capabilities.rag
        ? settings.capabilities.ragDirectory || "Choose a knowledge directory"
        : "Disabled in settings",
    },
    {
      id: "mcp",
      label: "MCP",
      enabled: settings.capabilities.mcp,
      status: settings.capabilities.mcp
        ? enabledServers
          ? "ready"
          : "attention"
        : "disabled",
      detail: settings.capabilities.mcp
        ? `${enabledServers} enabled server${enabledServers === 1 ? "" : "s"}`
        : "Disabled in settings",
    },
    {
      id: "team",
      label: "Team",
      enabled: settings.capabilities.team,
      status: settings.capabilities.team ? "ready" : "disabled",
      detail: settings.capabilities.team
        ? "Explorer and reviewer sub-agents"
        : "Disabled in settings",
    },
    {
      id: "trace",
      label: "Trace",
      enabled: settings.capabilities.trace,
      status: settings.capabilities.trace ? "ready" : "disabled",
      detail: settings.capabilities.trace
        ? "Local JSONL trace store"
        : "Disabled in settings",
    },
    {
      id: "compression",
      label: "Context compression",
      enabled: settings.capabilities.macroCompression,
      status: settings.capabilities.macroCompression ? "ready" : "disabled",
      detail: settings.capabilities.macroCompression
        ? "Automatic conversation summaries"
        : "Disabled in settings",
    },
    {
      id: "tool-search",
      label: "Tool search",
      enabled: settings.capabilities.toolSearch,
      status: settings.capabilities.toolSearch ? "ready" : "disabled",
      detail: settings.capabilities.toolSearch
        ? "Dynamic MCP tool discovery"
        : "Disabled in settings",
    },
  ];
}
