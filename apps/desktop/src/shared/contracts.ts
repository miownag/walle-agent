import type { Attachment } from "@walle-agent/core";

export type ThemeMode = "system" | "light" | "dark";
export type Density = "comfortable" | "compact";
export type ProviderKind = "openai" | "openai-compatible" | "anthropic";
export type SandboxKind = "local" | "docker";
export type PermissionMode = "auto" | "ask" | "deny-high-risk" | "full-access";
export type ThreadStatus = "idle" | "running" | "approval" | "error";
export type RunStatus = "running" | "completed" | "cancelled" | "error";

export interface ProviderModel {
  label?: string;
  value: string;
  description?: string;
}

export interface ProviderProfile {
  id: string;
  name: string;
  kind: ProviderKind;
  model: string;
  models?: ProviderModel[];
  baseUrl?: string;
  hasApiKey: boolean;
  apiKeyHint?: string;
  isDefault: boolean;
}

export interface ProviderProfileInput {
  id?: string;
  name: string;
  kind: ProviderKind;
  model: string;
  models?: ProviderModel[];
  baseUrl?: string;
  apiKey?: string;
  isDefault?: boolean;
}

export interface AppearanceSettings {
  theme: ThemeMode;
  density: Density;
  fontSize: number;
  codeFontSize: number;
  reduceMotion: boolean;
}

export interface SandboxSettings {
  kind: SandboxKind;
  timeoutMs: number;
  allowedCommands: string[];
  dockerImage: string;
  dockerMemory: string;
  dockerCpus: number;
  dockerNetwork: "none" | "bridge" | "host";
}

export interface PermissionSettings {
  mode: PermissionMode;
  approveFileWrites: boolean;
  approveShell: boolean;
  approveNetwork: boolean;
  approveHighRisk: boolean;
  alwaysAllowTools: string[];
  denyTools: string[];
}

export interface CapabilitySettings {
  memory: boolean;
  skills: boolean;
  evolution: boolean;
  rag: boolean;
  mcp: boolean;
  team: boolean;
  trace: boolean;
  macroCompression: boolean;
  toolSearch: boolean;
  evolutionEveryTurns: number;
  evolutionMinToolCalls: number;
  ragDirectory: string;
  recordTraceContent: boolean;
}

export interface McpServerSettings {
  id: string;
  name: string;
  enabled: boolean;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

export interface AppSettings {
  version: 1;
  appearance: AppearanceSettings;
  followUpMode?: FollowUpMode;
  sandbox: SandboxSettings;
  permissions: PermissionSettings;
  capabilities: CapabilitySettings;
  providers: ProviderProfile[];
  mcpServers: McpServerSettings[];
  userSkillsDirectory: string;
  defaultSystemPrompt: string;
  maxTurns: number;
  maxContextTokens: number;
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? Array<U>
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

export interface ThreadRecord {
  id: string;
  sessionId: string;
  title: string;
  workspaceRoot: string;
  workspaceName: string;
  providerProfileId: string;
  model: string;
  pinned: boolean;
  archived: boolean;
  unread: boolean;
  unreadAt?: string;
  status: ThreadStatus;
  createdAt: string;
  updatedAt: string;
  lastMessage?: string;
}

export type ThreadAttentionDelivery = "in-app" | "deferred";

export interface ThreadAttentionEvent {
  threadId: string;
  runId: string;
  completedAt: string;
  threadTitle: string;
  workspaceName: string;
  delivery: ThreadAttentionDelivery;
}

export interface ThreadNavigationRequest {
  requestId: string;
  threadId: string;
  requestedAt: string;
}

export interface ThreadStateEvent {
  thread: ThreadRecord;
  reason: "run-completed" | "marked-read" | "title-generated";
}

export type UserMessagePart =
  | { type: "text"; text: string }
  | {
      type: "file";
      name: string;
      relativePath: string;
    };

export interface UserTimelineItem {
  id: string;
  type: "user";
  content: string;
  parts?: UserMessagePart[];
  createdAt: string;
}

export type ProcessStepType =
  | "reasoning"
  | "tool"
  | "approval"
  | "status"
  | "subagent";
export type ProcessStepStatus =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "denied"
  | "cancelled";

export interface ProcessStep {
  id: string;
  type: ProcessStepType;
  title: string;
  content?: string;
  status: ProcessStepStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  toolName?: string;
  toolCallId?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  approvalId?: string;
  riskLevel?: "low" | "medium" | "high";
}

export interface AssistantTimelineItem {
  id: string;
  type: "assistant";
  runId: string;
  status: RunStatus;
  createdAt: string;
  completedAt?: string;
  steps: ProcessStep[];
  finalAnswer: string;
  draftAnswer: string;
  processDisclosure: "auto" | "expanded" | "collapsed";
  processUserOverride: boolean;
  error?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export type TimelineItem = UserTimelineItem | AssistantTimelineItem;

export interface ContextWindowSnapshot {
  /** Tokens occupying the context window at the latest model boundary. */
  usedTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  maxTokens?: number;
  source: "provider" | "estimated-history";
  updatedAt: string;
}

export type FollowUpMode = "queue" | "steer";

export interface PendingMessage {
  id: string;
  prompt: string;
  displayPrompt: string;
  displayParts?: UserMessagePart[];
  attachments: Attachment[];
  mode: FollowUpMode;
  createdAt: string;
}

export interface ThreadTimeline {
  version: 1;
  threadId: string;
  items: TimelineItem[];
  contextWindow?: ContextWindowSnapshot;
  pendingMessages?: PendingMessage[];
}

export interface ApprovalRequestDto {
  approvalId: string;
  threadId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  description: string;
  riskLevel: "low" | "medium" | "high";
  tags: string[];
  input: Record<string, unknown>;
  createdAt: string;
}

export type AgentEventType =
  | "messages.pending"
  | "message.sent"
  | "run.started"
  | "model.started"
  | "reasoning.delta"
  | "answer.delta"
  | "tool.started"
  | "tool.completed"
  | "approval.requested"
  | "approval.resolved"
  | "assistant.completed"
  | "context.updated"
  | "evolution.proposal"
  | "run.completed"
  | "run.cancelled"
  | "run.failed";

export interface AgentEventEnvelope<T = unknown> {
  version: 1;
  sequence: number;
  timestamp: string;
  threadId: string;
  sessionId: string;
  runId: string;
  turn?: number;
  type: AgentEventType;
  payload: T;
}

export interface FileEntry {
  name: string;
  path: string;
  relativePath: string;
  kind: "file" | "directory" | "symlink";
  size?: number;
  modifiedAt?: string;
  children?: FileEntry[];
}

export interface FilePreview {
  path: string;
  relativePath: string;
  content: string;
  language: string;
  truncated: boolean;
  totalBytes: number;
}

export const SUPPORTED_IMAGE_ATTACHMENT_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export type SupportedImageAttachmentMimeType =
  (typeof SUPPORTED_IMAGE_ATTACHMENT_MIME_TYPES)[number];

export const MAX_IMAGE_ATTACHMENTS = 4;
export const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES = 15 * 1024 * 1024;

export interface ImageAttachmentInput {
  mimeType: SupportedImageAttachmentMimeType;
  base64: string;
}

export interface SavedImageAttachment {
  path: string;
  relativePath: string;
  fileName: string;
  mimeType: SupportedImageAttachmentMimeType;
  size: number;
}

export type ContextCommand = "clear" | "compact";

export interface ContextResetResult {
  thread: ThreadRecord;
  timeline: ThreadTimeline;
}

export interface ContextCompactionResult {
  summary: string;
  beforeMessages: number;
  afterMessages: number;
  beforeTokens: number;
  afterTokens: number;
  droppedMessages: number;
}

export interface WorkspaceFileMatch {
  name: string;
  relativePath: string;
  path: string;
}

export interface CommandResult {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut?: boolean;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface TerminalSession {
  id: string;
  threadId: string;
  sandboxKind: SandboxKind;
  shell: string;
  size: TerminalSize;
  notice: string;
}

export interface TerminalDataEvent {
  terminalId: string;
  threadId: string;
  sequence: number;
  data: string;
}

export interface TerminalExitEvent {
  terminalId: string;
  threadId: string;
  exitCode: number;
  signal?: number;
}

export interface BrowserState {
  visible: boolean;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  scope?: "project" | "user";
  type: "prompt" | "workflow" | "code";
  tags: string[];
  confidence: number;
  usageCount: number;
}

export interface EvolutionProposalSummary {
  id: string;
  /** Owning desktop task. Optional on payloads produced by older app versions. */
  threadId?: string;
  type: "memory" | "skill";
  reason: "explicit_remember" | "periodic_review" | "task_review";
  status: "pending" | "approved" | "rejected" | "applied";
  title: string;
  content: string;
  confidence?: number;
  createdAt: string;
  sessionId?: string;
}

export interface CapabilityStatus {
  id: string;
  label: string;
  enabled: boolean;
  status: "ready" | "disabled" | "attention" | "error";
  detail: string;
}

export interface BootstrapPayload {
  settings: AppSettings;
  threads: ThreadRecord[];
  capabilities: CapabilityStatus[];
  platform: string;
  appVersion: string;
}

export interface CreateThreadInput {
  model?: string;
  workspaceRoot?: string;
  providerProfileId?: string;
  title?: string;
}

export interface UpdateThreadInput {
  model?: string;
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  providerProfileId?: string;
}

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopApi {
  bootstrap(): Promise<BootstrapPayload>;
  listThreads(): Promise<ThreadRecord[]>;
  createThread(input: CreateThreadInput): Promise<ThreadRecord | null>;
  updateThread(
    threadId: string,
    patch: UpdateThreadInput,
  ): Promise<ThreadRecord>;
  setActiveThreadIds(threadIds: string[]): Promise<void>;
  markThreadRead(threadId: string): Promise<ThreadRecord>;
  getPendingThreadAttentions(): Promise<ThreadAttentionEvent[]>;
  acknowledgeThreadAttention(threadId: string, runId: string): Promise<void>;
  getPendingThreadNavigation(): Promise<ThreadNavigationRequest | null>;
  deleteThread(threadId: string): Promise<void>;
  getTimeline(threadId: string): Promise<ThreadTimeline>;
  setProcessDisclosure(
    threadId: string,
    runId: string,
    disclosure: "expanded" | "collapsed",
  ): Promise<void>;
  startRun(
    threadId: string,
    prompt: string,
    imageAttachments?: SavedImageAttachment[],
    displayPrompt?: string,
    displayParts?: UserMessagePart[],
    mode?: FollowUpMode,
  ): Promise<{ runId: string; queued?: boolean; steered?: boolean }>;
  updatePendingMessage(
    threadId: string,
    messageId: string,
    action: "remove" | "steer" | "send",
  ): Promise<void>;
  cancelRun(threadId: string): Promise<void>;
  clearContext(threadId: string): Promise<ContextResetResult>;
  compactContext(threadId: string): Promise<ContextCompactionResult>;
  resolveApproval(
    approvalId: string,
    decision: "allow-once" | "always-allow" | "deny",
  ): Promise<void>;
  getSettings(): Promise<AppSettings>;
  updateSettings(patch: DeepPartial<AppSettings>): Promise<AppSettings>;
  upsertProvider(input: ProviderProfileInput): Promise<AppSettings>;
  deleteProvider(providerId: string): Promise<AppSettings>;
  pickWorkspace(): Promise<string | null>;
  readDirectory(
    workspaceRoot: string,
    relativePath?: string,
  ): Promise<FileEntry[]>;
  readFile(workspaceRoot: string, relativePath: string): Promise<FilePreview>;
  searchWorkspaceFiles(
    threadId: string,
    query: string,
  ): Promise<WorkspaceFileMatch[]>;
  searchDraftWorkspaceFiles(
    workspaceRoot: string,
    query: string,
  ): Promise<WorkspaceFileMatch[]>;
  saveImageAttachments(
    threadId: string,
    attachments: ImageAttachmentInput[],
  ): Promise<SavedImageAttachment[]>;
  runCommand(workspaceRoot: string, command: string): Promise<CommandResult>;
  createTerminal(
    threadId: string,
    size: TerminalSize,
  ): Promise<TerminalSession>;
  writeTerminal(terminalId: string, data: string): void;
  acknowledgeTerminal(terminalId: string, sequence: number): void;
  resizeTerminal(terminalId: string, size: TerminalSize): void;
  clearTerminal(terminalId: string): void;
  closeTerminal(terminalId: string): Promise<void>;
  listSkills(threadId?: string): Promise<SkillSummary[]>;
  listEvolutionProposals(
    threadId?: string,
  ): Promise<EvolutionProposalSummary[]>;
  resolveEvolutionProposal(
    threadId: string,
    proposalId: string,
    decision: "approve" | "reject",
  ): Promise<void>;
  showBrowser(bounds: BrowserBounds): Promise<void>;
  hideBrowser(): Promise<void>;
  setBrowserBounds(bounds: BrowserBounds): Promise<void>;
  navigateBrowser(url: string): Promise<void>;
  browserBack(): Promise<void>;
  browserForward(): Promise<void>;
  browserReload(): Promise<void>;
  openExternal(url: string): Promise<void>;
  onAgentEvent(listener: (event: AgentEventEnvelope) => void): () => void;
  onThreadAttention(
    listener: (event: ThreadAttentionEvent) => void,
  ): () => void;
  onThreadNavigation(
    listener: (event: ThreadNavigationRequest) => void,
  ): () => void;
  onThreadState(listener: (event: ThreadStateEvent) => void): () => void;
  onBrowserState(listener: (state: BrowserState) => void): () => void;
  onTerminalData(listener: (event: TerminalDataEvent) => void): () => void;
  onTerminalExit(listener: (event: TerminalExitEvent) => void): () => void;
}

export const IPC = {
  bootstrap: "app:bootstrap",
  threadList: "thread:list",
  threadCreate: "thread:create",
  threadUpdate: "thread:update",
  threadSetActive: "thread:set-active",
  threadMarkRead: "thread:mark-read",
  threadPendingAttentions: "thread:pending-attentions",
  threadAttentionAck: "thread:attention-ack",
  threadPendingNavigation: "thread:pending-navigation",
  threadDelete: "thread:delete",
  threadTimeline: "thread:timeline",
  threadDisclosure: "thread:disclosure",
  runStart: "run:start",
  runCancel: "run:cancel",
  pendingUpdate: "run:pending-update",
  contextClear: "context:clear",
  contextCompact: "context:compact",
  approvalResolve: "approval:resolve",
  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
  providerUpsert: "provider:upsert",
  providerDelete: "provider:delete",
  workspacePick: "workspace:pick",
  workspaceReadDirectory: "workspace:read-directory",
  workspaceReadFile: "workspace:read-file",
  workspaceSearchFiles: "workspace:search-files",
  workspaceSearchDraftFiles: "workspace:search-draft-files",
  workspaceSaveImageAttachments: "workspace:save-image-attachments",
  workspaceRunCommand: "workspace:run-command",
  terminalCreate: "terminal:create",
  terminalInput: "terminal:input",
  terminalAck: "terminal:ack",
  terminalResize: "terminal:resize",
  terminalClear: "terminal:clear",
  terminalClose: "terminal:close",
  terminalData: "terminal:data",
  terminalExit: "terminal:exit",
  skillsList: "skills:list",
  evolutionList: "evolution:list",
  evolutionResolve: "evolution:resolve",
  browserShow: "browser:show",
  browserHide: "browser:hide",
  browserBounds: "browser:bounds",
  browserNavigate: "browser:navigate",
  browserBack: "browser:back",
  browserForward: "browser:forward",
  browserReload: "browser:reload",
  openExternal: "app:open-external",
  agentEvent: "agent:event",
  threadAttention: "thread:attention",
  threadNavigate: "thread:navigate",
  threadState: "thread:state",
  browserState: "browser:state",
} as const;
