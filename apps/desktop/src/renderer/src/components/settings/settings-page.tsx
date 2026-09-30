import { useEffect, useState, type ReactNode } from "react";
import {
  IconArrowLeft,
  IconBolt,
  IconCheck,
  IconCpu,
  IconDatabase,
  IconInfoCircle,
  IconPalette,
  IconPlugConnected,
  IconPlus,
  IconShieldLock,
  IconTimeline,
  IconTrash,
  IconUsers,
  IconWand,
} from "@tabler/icons-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type {
  AppSettings,
  CapabilityStatus,
  DeepPartial,
  DesktopApi,
  McpServerSettings,
  ProviderKind,
  ProviderProfile,
  ProviderProfileInput,
  SkillSummary,
  ThemeMode,
} from "@shared/contracts";

type SettingsPage =
  | "appearance"
  | "providers"
  | "sandbox"
  | "skills"
  | "mcp"
  | "memory"
  | "evolution"
  | "team"
  | "trace"
  | "about";

interface SettingsPageProps {
  settings: AppSettings;
  capabilities: CapabilityStatus[];
  appVersion: string;
  platform: string;
  api: DesktopApi;
  saving: boolean;
  onBack: () => void;
  onPatch: (patch: DeepPartial<AppSettings>) => Promise<void>;
  onUpsertProvider: (input: ProviderProfileInput) => Promise<boolean>;
  onDeleteProvider: (providerId: string) => Promise<boolean>;
}

const pages: Array<{
  id: SettingsPage;
  label: string;
  icon: typeof IconPalette;
}> = [
  { id: "appearance", label: "Appearance", icon: IconPalette },
  { id: "providers", label: "Providers", icon: IconCpu },
  { id: "sandbox", label: "Sandbox & permissions", icon: IconShieldLock },
  { id: "skills", label: "Skills", icon: IconWand },
  { id: "mcp", label: "MCP", icon: IconPlugConnected },
  { id: "memory", label: "Memory & RAG", icon: IconDatabase },
  { id: "evolution", label: "Evolution", icon: IconBolt },
  { id: "team", label: "Team", icon: IconUsers },
  { id: "trace", label: "Trace", icon: IconTimeline },
  { id: "about", label: "About", icon: IconInfoCircle },
];

function PageHeading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mb-5">
      <h2 className="text-lg font-semibold tracking-[-0.015em]">{title}</h2>
      <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
        {description}
      </p>
    </div>
  );
}

function SettingsSection({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-6">
      {title && (
        <h3 className="mb-1.5 px-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          {title}
        </h3>
      )}
      <div className="divide-y divide-border/70 rounded-xl border border-border/80 bg-card/45 px-3">
        {children}
      </div>
    </section>
  );
}

function SettingsRow({
  label,
  description,
  children,
  className,
}: {
  label: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-h-14 items-center gap-5 py-2.5", className)}>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium">{label}</div>
        {description && (
          <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <SettingsRow label={label} description={description}>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label={label}
      />
    </SettingsRow>
  );
}

function AppearancePage({
  settings,
  onPatch,
}: Pick<SettingsPageProps, "settings" | "onPatch">) {
  const themes: Array<{ value: ThemeMode; label: string }> = [
    { value: "system", label: "System" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ];
  return (
    <>
      <PageHeading
        title="Appearance"
        description="Make Walle feel at home on this Mac."
      />
      <SettingsSection title="Theme">
        <SettingsRow
          label="Color theme"
          description="Follow macOS or keep a fixed theme."
        >
          <div className="flex rounded-lg bg-muted p-0.5">
            {themes.map((theme) => (
              <Button
                key={theme.value}
                size="sm"
                variant="ghost"
                className={cn(
                  "h-7 min-w-16 rounded-md text-[11px] font-normal",
                  settings.appearance.theme === theme.value &&
                    "bg-background shadow-sm",
                )}
                onClick={() =>
                  void onPatch({ appearance: { theme: theme.value } })
                }
              >
                {theme.label}
              </Button>
            ))}
          </div>
        </SettingsRow>
        <SettingsRow
          label="Density"
          description="Adjust spacing across lists and controls."
        >
          <div className="flex rounded-lg bg-muted p-0.5">
            {(["comfortable", "compact"] as const).map((density) => (
              <Button
                key={density}
                size="sm"
                variant="ghost"
                className={cn(
                  "h-7 rounded-md text-[11px] font-normal capitalize",
                  settings.appearance.density === density &&
                    "bg-background shadow-sm",
                )}
                onClick={() => void onPatch({ appearance: { density } })}
              >
                {density}
              </Button>
            ))}
          </div>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="Type">
        <SettingsRow
          label="Interface text"
          description={`${settings.appearance.fontSize}px`}
        >
          <Slider
            className="w-36"
            min={11}
            max={17}
            step={1}
            value={settings.appearance.fontSize}
            onValueChange={(value) =>
              void onPatch({ appearance: { fontSize: value as number } })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Code text"
          description={`${settings.appearance.codeFontSize}px`}
        >
          <Slider
            className="w-36"
            min={10}
            max={18}
            step={1}
            value={settings.appearance.codeFontSize}
            onValueChange={(value) =>
              void onPatch({ appearance: { codeFontSize: value as number } })
            }
          />
        </SettingsRow>
        <ToggleRow
          label="Reduce motion"
          description="Minimize streaming, pane, and disclosure animations."
          checked={settings.appearance.reduceMotion}
          onCheckedChange={(reduceMotion) =>
            void onPatch({ appearance: { reduceMotion } })
          }
        />
      </SettingsSection>
    </>
  );
}

interface ProviderDraft {
  id?: string;
  name: string;
  kind: ProviderKind;
  model: string;
  baseUrl: string;
  apiKey: string;
  isDefault: boolean;
}

function providerDraft(provider?: ProviderProfile): ProviderDraft {
  return {
    id: provider?.id,
    name: provider?.name ?? "",
    kind: provider?.kind ?? "openai",
    model: provider?.model ?? "",
    baseUrl: provider?.baseUrl ?? "",
    apiKey: "",
    isDefault: provider?.isDefault ?? false,
  };
}

function ProvidersPage({
  settings,
  onUpsertProvider,
  onDeleteProvider,
}: Pick<
  SettingsPageProps,
  "settings" | "onUpsertProvider" | "onDeleteProvider"
>) {
  const [editing, setEditing] = useState<ProviderDraft | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const save = async () => {
    if (!editing?.name.trim() || !editing.model.trim() || submitting) return;
    const input: ProviderProfileInput = {
      id: editing.id,
      name: editing.name.trim(),
      kind: editing.kind,
      model: editing.model.trim(),
      baseUrl: editing.baseUrl.trim() || undefined,
      isDefault: editing.isDefault,
    };
    // ProviderService distinguishes an omitted key from `apiKey: undefined`.
    // Omission preserves an existing secret when editing a profile.
    if (editing.apiKey) input.apiKey = editing.apiKey;
    setSubmitting(true);
    try {
      if (await onUpsertProvider(input)) setEditing(null);
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (providerId: string) => {
    if (deletingId || submitting) return;
    setDeletingId(providerId);
    try {
      await onDeleteProvider(providerId);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <>
      <div className="mb-5 flex items-start justify-between gap-4">
        <PageHeading
          title="Providers"
          description="Keys stay in the local secure store and are never rendered back in full."
        />
        <Button
          size="sm"
          disabled={submitting || Boolean(deletingId)}
          onClick={() => setEditing(providerDraft())}
        >
          <IconPlus /> Add provider
        </Button>
      </div>
      <SettingsSection title="Profiles">
        {settings.providers.map((provider) => (
          <div
            key={provider.id}
            className="flex min-h-16 items-center gap-3 py-2.5"
          >
            <div className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <IconCpu className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-xs font-medium">
                {provider.name}
                {provider.isDefault && (
                  <Badge variant="secondary" className="h-4 px-1.5 text-[9px]">
                    Default
                  </Badge>
                )}
              </div>
              <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
                {provider.model} · {provider.kind}
                {provider.hasApiKey
                  ? ` · key ${provider.apiKeyHint ?? "saved"}`
                  : " · no key"}
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              disabled={submitting || Boolean(deletingId)}
              onClick={() => setEditing(providerDraft(provider))}
            >
              Edit
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Delete ${provider.name}`}
              disabled={
                settings.providers.length < 2 ||
                submitting ||
                Boolean(deletingId)
              }
              onClick={() => void remove(provider.id)}
            >
              {deletingId === provider.id ? (
                <span className="size-3 animate-spin rounded-full border border-current border-t-transparent" />
              ) : (
                <IconTrash />
              )}
            </Button>
          </div>
        ))}
        {settings.providers.length === 0 && (
          <div className="py-8 text-center text-xs text-muted-foreground">
            Add a provider to start running agents.
          </div>
        )}
      </SettingsSection>

      {editing && (
        <SettingsSection title={editing.id ? "Edit profile" : "New profile"}>
          <div className="grid grid-cols-2 gap-3 py-3 max-[700px]:grid-cols-1">
            <Label className="flex-col items-stretch gap-1.5 text-[11px]">
              Name
              <Input
                value={editing.name}
                onChange={(event) =>
                  setEditing({ ...editing, name: event.currentTarget.value })
                }
              />
            </Label>
            <Label className="flex-col items-stretch gap-1.5 text-[11px]">
              Provider type
              <Select
                value={editing.kind}
                onValueChange={(kind) =>
                  setEditing({ ...editing, kind: kind as ProviderKind })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="anthropic">Anthropic</SelectItem>
                  <SelectItem value="openai-compatible">
                    OpenAI compatible
                  </SelectItem>
                </SelectContent>
              </Select>
            </Label>
            <Label className="flex-col items-stretch gap-1.5 text-[11px]">
              Model
              <Input
                value={editing.model}
                placeholder="gpt-5"
                onChange={(event) =>
                  setEditing({ ...editing, model: event.currentTarget.value })
                }
              />
            </Label>
            <Label className="flex-col items-stretch gap-1.5 text-[11px]">
              Base URL{" "}
              <span className="font-normal text-muted-foreground">
                optional
              </span>
              <Input
                value={editing.baseUrl}
                placeholder="https://api.example.com/v1"
                onChange={(event) =>
                  setEditing({ ...editing, baseUrl: event.currentTarget.value })
                }
              />
            </Label>
            <Label className="col-span-2 flex-col items-stretch gap-1.5 text-[11px] max-[700px]:col-span-1">
              API key{" "}
              <span className="font-normal text-muted-foreground">
                leave blank to keep the saved key
              </span>
              <Input
                type="password"
                value={editing.apiKey}
                placeholder="••••••••"
                onChange={(event) =>
                  setEditing({ ...editing, apiKey: event.currentTarget.value })
                }
              />
            </Label>
            <label className="col-span-2 flex items-center gap-2 text-[11px] max-[700px]:col-span-1">
              <Switch
                checked={editing.isDefault}
                onCheckedChange={(isDefault) =>
                  setEditing({ ...editing, isDefault })
                }
              />
              Use as default provider
            </label>
            <div className="col-span-2 flex justify-end gap-2 max-[700px]:col-span-1">
              <Button
                variant="outline"
                disabled={submitting}
                onClick={() => setEditing(null)}
              >
                Cancel
              </Button>
              <Button
                disabled={
                  !editing.name.trim() || !editing.model.trim() || submitting
                }
                onClick={() => void save()}
              >
                {submitting ? "Saving…" : "Save provider"}
              </Button>
            </div>
          </div>
        </SettingsSection>
      )}
    </>
  );
}

function SandboxPage({
  settings,
  onPatch,
}: Pick<SettingsPageProps, "settings" | "onPatch">) {
  return (
    <>
      <PageHeading
        title="Sandbox & permissions"
        description="Define where commands run and when Walle must stop to ask."
      />
      <SettingsSection title="Execution">
        <SettingsRow
          label="Sandbox"
          description="Local uses the current Mac account; Docker creates stronger isolation."
        >
          <Select
            value={settings.sandbox.kind}
            onValueChange={(kind) =>
              void onPatch({ sandbox: { kind: kind as "local" | "docker" } })
            }
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="local">Local process</SelectItem>
              <SelectItem value="docker">Docker</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          label="Command timeout"
          description="Maximum time for a single sandbox command."
        >
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              defaultValue={Math.round(settings.sandbox.timeoutMs / 1000)}
              key={settings.sandbox.timeoutMs}
              className="w-20"
              onBlur={(event) =>
                void onPatch({
                  sandbox: {
                    timeoutMs:
                      Math.max(1, Number(event.currentTarget.value)) * 1000,
                  },
                })
              }
            />
            <span className="text-[10px] text-muted-foreground">seconds</span>
          </div>
        </SettingsRow>
        {settings.sandbox.kind === "docker" && (
          <>
            <SettingsRow label="Docker image">
              <Input
                className="w-56"
                defaultValue={settings.sandbox.dockerImage}
                onBlur={(event) =>
                  void onPatch({
                    sandbox: { dockerImage: event.currentTarget.value },
                  })
                }
              />
            </SettingsRow>
            <SettingsRow label="Network">
              <Select
                value={settings.sandbox.dockerNetwork}
                onValueChange={(dockerNetwork) =>
                  void onPatch({
                    sandbox: {
                      dockerNetwork: dockerNetwork as
                        | "none"
                        | "bridge"
                        | "host",
                    },
                  })
                }
              >
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="bridge">Bridge</SelectItem>
                  <SelectItem value="host">Host</SelectItem>
                </SelectContent>
              </Select>
            </SettingsRow>
          </>
        )}
      </SettingsSection>

      <SettingsSection title="Approval policy">
        <SettingsRow
          label="Default mode"
          description="Ask is the safest choice for interactive coding."
        >
          <Select
            value={settings.permissions.mode}
            onValueChange={(mode) =>
              void onPatch({
                permissions: {
                  mode: mode as "auto" | "ask" | "deny-high-risk",
                },
              })
            }
          >
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ask">Ask before actions</SelectItem>
              <SelectItem value="auto">Approve automatically</SelectItem>
              <SelectItem value="deny-high-risk">Deny high-risk</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
        <ToggleRow
          label="File writes"
          description="Ask before creating or modifying workspace files."
          checked={settings.permissions.approveFileWrites}
          onCheckedChange={(approveFileWrites) =>
            void onPatch({ permissions: { approveFileWrites } })
          }
        />
        <ToggleRow
          label="Shell commands"
          description="Ask before running local or sandbox commands."
          checked={settings.permissions.approveShell}
          onCheckedChange={(approveShell) =>
            void onPatch({ permissions: { approveShell } })
          }
        />
        <ToggleRow
          label="Network access"
          description="Ask before tools connect to the network."
          checked={settings.permissions.approveNetwork}
          onCheckedChange={(approveNetwork) =>
            void onPatch({ permissions: { approveNetwork } })
          }
        />
        <ToggleRow
          label="High-risk actions"
          description="Always gate destructive or privileged operations."
          checked={settings.permissions.approveHighRisk}
          onCheckedChange={(approveHighRisk) =>
            void onPatch({ permissions: { approveHighRisk } })
          }
        />
      </SettingsSection>

      <SettingsSection title="Remembered tool decisions">
        {settings.permissions.alwaysAllowTools.map((tool) => (
          <div
            key={`allow:${tool}`}
            className="flex min-h-11 items-center gap-2 py-2"
          >
            <Badge variant="secondary" className="h-5 px-2 text-[9px]">
              Always allow
            </Badge>
            <code className="min-w-0 flex-1 truncate text-[10px]" title={tool}>
              {tool}
            </code>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Forget always allow for ${tool}`}
              onClick={() =>
                void onPatch({
                  permissions: {
                    alwaysAllowTools:
                      settings.permissions.alwaysAllowTools.filter(
                        (item) => item !== tool,
                      ),
                  },
                })
              }
            >
              <IconTrash />
            </Button>
          </div>
        ))}
        {settings.permissions.denyTools.map((tool) => (
          <div
            key={`deny:${tool}`}
            className="flex min-h-11 items-center gap-2 py-2"
          >
            <Badge variant="destructive" className="h-5 px-2 text-[9px]">
              Denied
            </Badge>
            <code className="min-w-0 flex-1 truncate text-[10px]" title={tool}>
              {tool}
            </code>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Forget deny for ${tool}`}
              onClick={() =>
                void onPatch({
                  permissions: {
                    denyTools: settings.permissions.denyTools.filter(
                      (item) => item !== tool,
                    ),
                  },
                })
              }
            >
              <IconTrash />
            </Button>
          </div>
        ))}
        {settings.permissions.alwaysAllowTools.length === 0 &&
        settings.permissions.denyTools.length === 0 ? (
          <div className="py-5 text-center text-[10px] leading-4 text-muted-foreground">
            No remembered tool decisions. Eligible low-risk approvals can be
            remembered here.
          </div>
        ) : (
          <div className="flex min-h-12 items-center gap-3 py-2">
            <p className="min-w-0 flex-1 text-[10px] leading-4 text-muted-foreground">
              These decisions apply across local tasks until removed.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void onPatch({
                  permissions: { alwaysAllowTools: [], denyTools: [] },
                })
              }
            >
              Reset all
            </Button>
          </div>
        )}
      </SettingsSection>
    </>
  );
}

function SkillsPage({
  settings,
  api,
  onPatch,
}: Pick<SettingsPageProps, "settings" | "api" | "onPatch">) {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setLoading(true);
    void api
      .listSkills()
      .then(setSkills)
      .finally(() => setLoading(false));
  }, [api]);
  return (
    <>
      <PageHeading
        title="Skills"
        description="Reusable local instructions and workflows available to Walle."
      />
      <SettingsSection title="Configuration">
        <ToggleRow
          label="Enable skills"
          description="Let Walle discover project and user skills when relevant."
          checked={settings.capabilities.skills}
          onCheckedChange={(skills) =>
            void onPatch({ capabilities: { skills } })
          }
        />
        <SettingsRow label="User skills directory">
          <Input
            className="w-72"
            defaultValue={settings.userSkillsDirectory}
            onBlur={(event) =>
              void onPatch({ userSkillsDirectory: event.currentTarget.value })
            }
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection
        title={`Installed${skills.length ? ` · ${skills.length}` : ""}`}
      >
        {loading && (
          <div className="py-5 text-center text-xs text-muted-foreground">
            Loading skills…
          </div>
        )}
        {!loading &&
          skills.map((skill) => (
            <div
              key={skill.id}
              className="flex min-h-16 items-center gap-3 py-2.5"
            >
              <div className="flex size-8 items-center justify-center rounded-lg bg-[var(--brand-soft)] text-[var(--brand)]">
                <IconWand className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium">{skill.name}</div>
                <div className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-muted-foreground">
                  {skill.description}
                </div>
              </div>
              <div className="text-right text-[9px] text-muted-foreground">
                <div>{skill.scope ?? "user"}</div>
                <div>{skill.usageCount} uses</div>
              </div>
            </div>
          ))}
        {!loading && skills.length === 0 && (
          <div className="py-7 text-center text-xs text-muted-foreground">
            No skills found in this workspace.
          </div>
        )}
      </SettingsSection>
    </>
  );
}

function McpPage({
  settings,
  onPatch,
}: Pick<SettingsPageProps, "settings" | "onPatch">) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const updateServer = (id: string, patch: Partial<McpServerSettings>) =>
    onPatch({
      mcpServers: settings.mcpServers.map((server) =>
        server.id === id ? { ...server, ...patch } : server,
      ),
    });
  const add = async () => {
    if (!name.trim() || !command.trim()) return;
    await onPatch({
      mcpServers: [
        ...settings.mcpServers,
        {
          id: crypto.randomUUID(),
          name: name.trim(),
          enabled: true,
          transport: "stdio",
          command: command.trim(),
          args: [],
        },
      ],
    });
    setName("");
    setCommand("");
    setAdding(false);
  };
  return (
    <>
      <div className="mb-5 flex items-start justify-between gap-4">
        <PageHeading
          title="MCP"
          description="Connect local Model Context Protocol servers to the agent tool registry."
        />
        <Button size="sm" onClick={() => setAdding(true)}>
          <IconPlus /> Add server
        </Button>
      </div>
      <SettingsSection title="Runtime">
        <ToggleRow
          label="Enable MCP"
          description="Load enabled servers when a session starts."
          checked={settings.capabilities.mcp}
          onCheckedChange={(mcp) => void onPatch({ capabilities: { mcp } })}
        />
      </SettingsSection>
      <SettingsSection title="Servers">
        {settings.mcpServers.map((server) => (
          <div
            key={server.id}
            className="flex min-h-16 items-center gap-3 py-2.5"
          >
            <Switch
              size="sm"
              checked={server.enabled}
              onCheckedChange={(enabled) =>
                void updateServer(server.id, { enabled })
              }
            />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium">{server.name}</div>
              <div className="mt-0.5 truncate font-mono text-[9px] text-muted-foreground">
                {server.transport === "stdio"
                  ? [server.command, ...(server.args ?? [])].join(" ")
                  : server.url}
              </div>
            </div>
            <Badge variant="outline" className="h-4 px-1.5 text-[9px]">
              {server.transport}
            </Badge>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${server.name}`}
              onClick={() =>
                void onPatch({
                  mcpServers: settings.mcpServers.filter(
                    (item) => item.id !== server.id,
                  ),
                })
              }
            >
              <IconTrash />
            </Button>
          </div>
        ))}
        {settings.mcpServers.length === 0 && !adding && (
          <div className="py-7 text-center text-xs text-muted-foreground">
            No MCP servers configured.
          </div>
        )}
        {adding && (
          <div className="grid grid-cols-[1fr_1.5fr_auto] gap-2 py-3 max-[700px]:grid-cols-1">
            <Input
              placeholder="Server name"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
            <Input
              placeholder="Command, e.g. npx server"
              value={command}
              onChange={(event) => setCommand(event.currentTarget.value)}
            />
            <div className="flex gap-1">
              <Button variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button
                disabled={!name.trim() || !command.trim()}
                onClick={() => void add()}
              >
                Add
              </Button>
            </div>
          </div>
        )}
      </SettingsSection>
    </>
  );
}

function MemoryPage({
  settings,
  onPatch,
}: Pick<SettingsPageProps, "settings" | "onPatch">) {
  return (
    <>
      <PageHeading
        title="Memory & RAG"
        description="Keep durable preferences and retrieve relevant local project context."
      />
      <SettingsSection title="Capabilities">
        <ToggleRow
          label="Memory"
          description="Carry useful preferences and facts across local sessions."
          checked={settings.capabilities.memory}
          onCheckedChange={(memory) =>
            void onPatch({ capabilities: { memory } })
          }
        />
        <ToggleRow
          label="Retrieval (RAG)"
          description="Index and search an explicitly selected local directory."
          checked={settings.capabilities.rag}
          onCheckedChange={(rag) => void onPatch({ capabilities: { rag } })}
        />
        <ToggleRow
          label="Macro compression"
          description="Compact older context while retaining important details."
          checked={settings.capabilities.macroCompression}
          onCheckedChange={(macroCompression) =>
            void onPatch({ capabilities: { macroCompression } })
          }
        />
        <ToggleRow
          label="Tool search"
          description="Discover large tool catalogs only when needed."
          checked={settings.capabilities.toolSearch}
          onCheckedChange={(toolSearch) =>
            void onPatch({ capabilities: { toolSearch } })
          }
        />
      </SettingsSection>
      <SettingsSection title="Context">
        <SettingsRow label="RAG directory">
          <Input
            className="w-72"
            defaultValue={settings.capabilities.ragDirectory}
            onBlur={(event) =>
              void onPatch({
                capabilities: { ragDirectory: event.currentTarget.value },
              })
            }
          />
        </SettingsRow>
        <SettingsRow label="Maximum context tokens">
          <Input
            type="number"
            className="w-28"
            defaultValue={settings.maxContextTokens}
            onBlur={(event) =>
              void onPatch({
                maxContextTokens: Number(event.currentTarget.value),
              })
            }
          />
        </SettingsRow>
        <div className="py-3">
          <Label className="mb-1.5 text-[11px]">Default system prompt</Label>
          <Textarea
            defaultValue={settings.defaultSystemPrompt}
            className="min-h-24 text-xs"
            onBlur={(event) =>
              void onPatch({ defaultSystemPrompt: event.currentTarget.value })
            }
          />
        </div>
      </SettingsSection>
    </>
  );
}

function EvolutionPage({
  settings,
  onPatch,
}: Pick<SettingsPageProps, "settings" | "onPatch">) {
  return (
    <>
      <PageHeading
        title="Evolution"
        description="Walle can propose memories and skills after reviewing completed work. Proposals require your review before they become active."
      />
      <SettingsSection title="Self-improvement">
        <ToggleRow
          label="Enable evolution"
          description="Review sends recent conversation and tool context to the configured model provider, then stores resulting proposals locally."
          checked={settings.capabilities.evolution}
          onCheckedChange={(evolution) =>
            void onPatch({ capabilities: { evolution } })
          }
        />
        <SettingsRow
          label="Review interval"
          description="Run a periodic review after this many turns."
        >
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              className="w-20"
              defaultValue={settings.capabilities.evolutionEveryTurns}
              onBlur={(event) =>
                void onPatch({
                  capabilities: {
                    evolutionEveryTurns: Number(event.currentTarget.value),
                  },
                })
              }
            />
            <span className="text-[10px] text-muted-foreground">turns</span>
          </div>
        </SettingsRow>
        <SettingsRow
          label="Minimum tool calls"
          description="Skip low-signal tasks below this threshold."
        >
          <Input
            type="number"
            min={0}
            className="w-20"
            defaultValue={settings.capabilities.evolutionMinToolCalls}
            onBlur={(event) =>
              void onPatch({
                capabilities: {
                  evolutionMinToolCalls: Number(event.currentTarget.value),
                },
              })
            }
          />
        </SettingsRow>
      </SettingsSection>
      <div className="rounded-xl border border-[var(--brand)]/20 bg-[var(--brand-soft)] px-4 py-3 text-xs leading-5 text-foreground/80">
        Evolution performs an additional model review using recent task context.
        The resulting proposals are stored locally under Walle’s project data;
        rejected proposals never enter memory or skills.
      </div>
    </>
  );
}

function TeamPage({
  settings,
  onPatch,
}: Pick<SettingsPageProps, "settings" | "onPatch">) {
  return (
    <>
      <PageHeading
        title="Team"
        description="Let the lead agent delegate bounded, read-only workspace exploration and review."
      />
      <SettingsSection title="Coordination">
        <ToggleRow
          label="Enable team mode"
          description="Expose explorer and reviewer sub-agents when a task benefits from focused investigation."
          checked={settings.capabilities.team}
          onCheckedChange={(team) => void onPatch({ capabilities: { team } })}
        />
        <SettingsRow
          label="Maximum turns"
          description="Overall safety bound for one requested run."
        >
          <Input
            type="number"
            min={1}
            className="w-20"
            defaultValue={settings.maxTurns}
            onBlur={(event) =>
              void onPatch({ maxTurns: Number(event.currentTarget.value) })
            }
          />
        </SettingsRow>
      </SettingsSection>
      <p className="px-1 text-[10px] leading-4 text-muted-foreground">
        Explorer and reviewer sub-agents share the workspace and configured
        provider, and operate with read-only tools. Their task steps appear as
        collapsible process entries in the conversation.
      </p>
    </>
  );
}

function TracePage({
  settings,
  onPatch,
}: Pick<SettingsPageProps, "settings" | "onPatch">) {
  return (
    <>
      <PageHeading
        title="Trace"
        description="Capture local structured events for debugging agent behavior and performance."
      />
      <SettingsSection title="Recording">
        <ToggleRow
          label="Enable traces"
          description="Store run, model, tool, approval, and evolution spans locally."
          checked={settings.capabilities.trace}
          onCheckedChange={(trace) => void onPatch({ capabilities: { trace } })}
        />
        <ToggleRow
          label="Record content"
          description="Include prompts, model text, and tool payloads. May contain source code or secrets."
          checked={settings.capabilities.recordTraceContent}
          onCheckedChange={(recordTraceContent) =>
            void onPatch({ capabilities: { recordTraceContent } })
          }
        />
      </SettingsSection>
      {settings.capabilities.recordTraceContent && (
        <div className="rounded-lg border border-[var(--warning)]/25 bg-[var(--warning-soft)] px-3 py-2 text-[10px] leading-4 text-foreground/80">
          Trace content can contain sensitive workspace data. Keep the local
          trace directory out of source control.
        </div>
      )}
    </>
  );
}

function AboutPage({
  capabilities,
  appVersion,
  platform,
}: Pick<SettingsPageProps, "capabilities" | "appVersion" | "platform">) {
  return (
    <>
      <PageHeading
        title="About Walle"
        description="A local-only Agent Development Environment for coding."
      />
      <div className="mb-7 flex items-center gap-4">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-[var(--brand-soft)] text-[var(--brand)] shadow-sm">
          <IconBolt className="size-7" />
        </div>
        <div>
          <div className="text-base font-semibold">Walle</div>
          <div className="text-xs text-muted-foreground">
            Version {appVersion} · {platform}
          </div>
          <div className="mt-1 text-[10px] text-[var(--success)]">
            Local services ready
          </div>
        </div>
      </div>
      <SettingsSection title="Capabilities">
        {capabilities.map((capability) => (
          <div
            key={capability.id}
            className="flex min-h-12 items-center gap-3 py-2"
          >
            <span
              className={cn(
                "flex size-5 items-center justify-center rounded-full",
                capability.status === "ready"
                  ? "bg-[var(--success-soft)] text-[var(--success)]"
                  : capability.status === "error"
                    ? "bg-destructive/10 text-destructive"
                    : "bg-muted text-muted-foreground",
              )}
            >
              <IconCheck className="size-3" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium">{capability.label}</div>
              <div className="truncate text-[9px] text-muted-foreground">
                {capability.id === "team" && capability.enabled
                  ? "Explorer and reviewer sub-agents"
                  : capability.detail}
              </div>
            </div>
            <span className="text-[9px] capitalize text-muted-foreground">
              {capability.status}
            </span>
          </div>
        ))}
      </SettingsSection>
      <p className="text-center text-[10px] leading-4 text-muted-foreground">
        Conversations, settings, indexes, traces, and evolution proposals are
        stored on this Mac. Each run sends selected prompt and code context to
        the configured model provider. Tool-initiated network access is
        controlled separately by approvals.
      </p>
    </>
  );
}

export function SettingsPage({
  settings,
  capabilities,
  appVersion,
  platform,
  api,
  saving,
  onBack,
  onPatch,
  onUpsertProvider,
  onDeleteProvider,
}: SettingsPageProps) {
  const [page, setPage] = useState<SettingsPage>("appearance");
  const currentLabel =
    pages.find((item) => item.id === page)?.label ?? "Settings";

  return (
    <section
      className="h-full min-h-0 min-w-0 overflow-hidden bg-background"
      aria-label="Walle settings"
    >
      <div className="grid h-full min-h-0 min-w-0 grid-cols-[220px_minmax(0,1fr)] max-[680px]:grid-cols-[58px_minmax(0,1fr)]">
        <nav
          className="flex min-h-0 flex-col border-r bg-muted/20 px-2 py-3"
          aria-label="Settings pages"
        >
          <button
            type="button"
            className="mb-2 flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            onClick={onBack}
          >
            <IconArrowLeft className="size-3.5 shrink-0" />
            <span className="truncate max-[680px]:sr-only">
              Back to conversations
            </span>
          </button>
          <div className="mb-2 flex h-8 items-center border-t px-2 pt-2 text-xs font-semibold max-[680px]:sr-only">
            Settings
          </div>
          <div className="space-y-0.5">
            {pages.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  title={item.label}
                  className={cn(
                    "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                    page === item.id && "bg-muted text-foreground",
                  )}
                  onClick={() => setPage(item.id)}
                >
                  <Icon className="size-3.5 shrink-0" />
                  <span className="truncate max-[680px]:sr-only">
                    {item.label}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="mt-auto px-2 py-1 text-[9px] text-muted-foreground max-[680px]:hidden">
            {saving ? "Saving…" : "Saved locally"}
          </div>
        </nav>
        <div className="min-h-0 min-w-0 overflow-y-auto overflow-x-hidden px-8 py-7 max-[680px]:px-4">
          <div className="sr-only">{currentLabel}</div>
          {page === "appearance" && (
            <AppearancePage settings={settings} onPatch={onPatch} />
          )}
          {page === "providers" && (
            <ProvidersPage
              settings={settings}
              onUpsertProvider={onUpsertProvider}
              onDeleteProvider={onDeleteProvider}
            />
          )}
          {page === "sandbox" && (
            <SandboxPage settings={settings} onPatch={onPatch} />
          )}
          {page === "skills" && (
            <SkillsPage settings={settings} api={api} onPatch={onPatch} />
          )}
          {page === "mcp" && <McpPage settings={settings} onPatch={onPatch} />}
          {page === "memory" && (
            <MemoryPage settings={settings} onPatch={onPatch} />
          )}
          {page === "evolution" && (
            <EvolutionPage settings={settings} onPatch={onPatch} />
          )}
          {page === "team" && (
            <TeamPage settings={settings} onPatch={onPatch} />
          )}
          {page === "trace" && (
            <TracePage settings={settings} onPatch={onPatch} />
          )}
          {page === "about" && (
            <AboutPage
              capabilities={capabilities}
              appVersion={appVersion}
              platform={platform}
            />
          )}
        </div>
      </div>
    </section>
  );
}
