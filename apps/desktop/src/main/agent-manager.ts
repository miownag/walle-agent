import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  Agent,
  type AgentConfig,
  type Attachment,
  type PermissionPolicy,
  type WallePlugin,
} from "@walle-agent/core";
import {
  EvolutionPlugin,
  type EvolutionProposal,
} from "@walle-agent/evolution";
import { MCPPlugin, type MCPServerConfig } from "@walle-agent/mcp";
import { MemoryPlugin } from "@walle-agent/memory";
import { SimpleRAGPlugin } from "@walle-agent/rag";
import { buildShellTool } from "@walle-agent/sandbox";
import { SkillsPlugin } from "@walle-agent/skills";
import { SubAgentsPlugin } from "@walle-agent/team";
import { TracePlugin } from "@walle-agent/trace";
import type {
  AgentEventEnvelope,
  AppSettings,
  AssistantTimelineItem,
  ContextWindowSnapshot,
  EvolutionProposalSummary,
  SkillSummary,
  ThreadRecord,
  ThreadTimeline,
  UserMessagePart,
} from "../shared/contracts";
import {
  ApprovalBroker,
  type ApprovalBrokerEvent,
  type ApprovalDecision,
} from "./approval-broker";
import { DesktopStore } from "./desktop-store";
import { AgentEventNormalizer } from "./event-normalizer";
import { ProviderService } from "./provider-service";
import {
  ThreadTitleService,
  type ThreadTitleGeneratedSink,
} from "./thread-title-service";
import { WorkspaceBoundary } from "./workspace-boundary";
import { WorkspaceSandbox } from "./workspace-sandbox";

interface ActiveDesktopRun {
  runId: string;
  normalizer: AgentEventNormalizer;
  timeline: ThreadTimeline;
  done: Promise<void>;
  persistTimer?: ReturnType<typeof setTimeout>;
}

interface AgentHandle {
  signature: string;
  agent: Agent;
  skills?: SkillsPlugin;
  evolution?: EvolutionPlugin;
  active?: ActiveDesktopRun;
  lastNormalizer?: AgentEventNormalizer;
  stale: boolean;
}

export type AgentEventSink = (event: AgentEventEnvelope) => void;

export interface AgentRunCompleted {
  threadId: string;
  runId: string;
  completedAt: string;
}

export type AgentRunCompletedSink = (
  completion: AgentRunCompleted,
) => Promise<void> | void;

const DELETE_RUN_WAIT_MS = 10_000;

async function waitForRunToStop(
  done: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            "The active command did not stop in time. The task was not deleted; wait for the command to finish and try again.",
          ),
        ),
      timeoutMs,
    );
    timer.unref?.();
  });
  try {
    await Promise.race([done, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function runtimeSignature(thread: ThreadRecord, settings: AppSettings): string {
  return JSON.stringify({
    workspaceRoot: thread.workspaceRoot,
    providerProfileId: thread.providerProfileId,
    model: thread.model,
    systemPrompt: settings.defaultSystemPrompt,
    maxTurns: settings.maxTurns,
    maxContextTokens: settings.maxContextTokens,
    sandbox: settings.sandbox,
    permissions: settings.permissions,
    capabilities: settings.capabilities,
    mcpServers: settings.mcpServers,
    userSkillsDirectory: settings.userSkillsDirectory,
  });
}

function proposalSummary(
  proposal: EvolutionProposal,
  threadId: string,
): EvolutionProposalSummary {
  const memory =
    proposal.type === "memory"
      ? (proposal.payload as { content: string; confidence?: number })
      : undefined;
  const skill =
    proposal.type === "skill"
      ? (proposal.payload as {
          name: string;
          description: string;
          content: string;
          confidence?: number;
        })
      : undefined;
  return {
    id: proposal.id ?? `pending-${proposal.runId ?? randomUUID()}`,
    threadId,
    type: proposal.type,
    reason: proposal.reason,
    status: proposal.status ?? "pending",
    title:
      skill?.name ??
      `${proposal.type === "memory" ? "Memory" : "Skill"} proposal`,
    content: memory?.content ?? skill?.content ?? skill?.description ?? "",
    confidence: memory?.confidence ?? skill?.confidence,
    createdAt: proposal.createdAt ?? new Date().toISOString(),
    sessionId: proposal.sessionId,
  };
}

function skillSummary(
  skill: ReturnType<SkillsPlugin["registry"]["list"]>[number],
): SkillSummary {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    scope: skill.scope,
    type: skill.type,
    tags: skill.tags ?? [],
    confidence: skill.metadata.confidence,
    usageCount: skill.metadata.usageCount,
  };
}

const NON_PERSISTABLE_APPROVAL_TAGS = new Set([
  "file-write",
  "shell",
  "network",
  "mcp",
]);

function canPersistAlwaysAllow(request: {
  riskLevel?: string;
  tags?: string[];
}): boolean {
  return (
    request.riskLevel === "low" &&
    !(request.tags ?? []).some((tag) => NON_PERSISTABLE_APPROVAL_TAGS.has(tag))
  );
}

function splitCommandLine(command: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of command.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (character === "'" || character === '"') {
      if (!quote) quote = character;
      else if (quote === character) quote = undefined;
      else current += character;
      continue;
    }
    if (/\s/.test(character) && !quote) {
      if (current) result.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("MCP command has an unmatched quote");
  if (current) result.push(current);
  return result;
}

export class AgentManager {
  private readonly handles = new Map<string, AgentHandle>();
  private readonly reservedThreads = new Set<string>();
  private readonly setupBarriers = new Map<string, Promise<void>>();
  private readonly setupControllers = new Map<string, AbortController>();
  private readonly broker: ApprovalBroker;
  private readonly titles: ThreadTitleService;

  constructor(
    private readonly store: DesktopStore,
    private readonly providers: ProviderService,
    private readonly runtimeRoot: string,
    private readonly emit: AgentEventSink,
    private readonly onRunCompleted?: AgentRunCompletedSink,
    onThreadTitleGenerated?: ThreadTitleGeneratedSink,
  ) {
    this.titles = new ThreadTitleService(
      store,
      providers,
      onThreadTitleGenerated,
    );
    this.broker = new ApprovalBroker(
      (event) => {
        void this.onApprovalEvent(event).catch((error) => {
          console.error("Failed to persist approval state:", error);
        });
      },
      async (request) => {
        // A tool-name-only global exception is not sufficiently scoped for
        // commands, writes, network access, or third-party MCP tools.
        if (!canPersistAlwaysAllow(request)) return false;
        const settings = this.store.getSettings();
        if (settings.permissions.alwaysAllowTools.includes(request.toolName))
          return true;
        await this.store.updateSettings({
          permissions: {
            alwaysAllowTools: [
              ...settings.permissions.alwaysAllowTools,
              request.toolName,
            ],
          },
        });
        return true;
      },
    );
  }

  async startRun(
    threadId: string,
    prompt: string,
    attachments: Attachment[] = [],
    displayPrompt = prompt,
    displayParts?: UserMessagePart[],
  ): Promise<{ runId: string }> {
    const content = prompt.trim();
    if (!content) throw new Error("Prompt is required");
    const visibleContent = displayPrompt.trim() || content;
    if (this.reservedThreads.has(threadId))
      throw new Error("This task already has a run in progress");
    this.reservedThreads.add(threadId);
    let releaseSetup!: () => void;
    const setupBarrier = new Promise<void>((resolveBarrier) => {
      releaseSetup = resolveBarrier;
    });
    this.setupBarriers.set(threadId, setupBarrier);
    const setupController = new AbortController();
    this.setupControllers.set(threadId, setupController);
    let preparedHandle: AgentHandle | undefined;
    let preparedActive: ActiveDesktopRun | undefined;

    try {
      const thread = this.requireThread(threadId);
      const handle = await this.ensureHandle(thread, setupController.signal);
      preparedHandle = handle;
      if (handle.active || handle.agent.isRunning)
        throw new Error("This task already has a run in progress");

      const runId = randomUUID();
      const now = new Date().toISOString();
      const timeline = this.store.getTimeline(threadId);
      const shouldGenerateTitle =
        thread.title === "New task" &&
        !timeline.items.some((item) => item.type === "user");
      timeline.items.push({
        id: randomUUID(),
        type: "user",
        content: visibleContent,
        ...(displayParts?.length ? { parts: displayParts } : {}),
        createdAt: now,
      });
      const assistant: AssistantTimelineItem = {
        id: randomUUID(),
        type: "assistant",
        runId,
        status: "running",
        createdAt: now,
        steps: [],
        finalAnswer: "",
        draftAnswer: "",
        processDisclosure: "auto",
        processUserOverride: false,
      };
      timeline.items.push(assistant);
      const normalizer = new AgentEventNormalizer(
        { threadId, sessionId: thread.sessionId, runId },
        assistant,
      );
      const active: ActiveDesktopRun = {
        runId,
        normalizer,
        timeline,
        done: Promise.resolve(),
      };
      preparedActive = active;
      await this.store.saveTimeline(timeline);
      const patch: Parameters<DesktopStore["updateThread"]>[1] = {
        status: "running",
        lastMessage: visibleContent.slice(0, 280),
      };
      await this.store.updateThread(threadId, patch);
      handle.active = active;
      handle.lastNormalizer = normalizer;
      this.emit(normalizer.started(visibleContent));

      active.done = this.executeRun(
        thread,
        handle,
        active,
        content,
        attachments,
      );
      void active.done.catch(() => undefined);
      if (shouldGenerateTitle) {
        // This auxiliary request is intentionally detached from the agent run:
        // it uses an isolated provider chat and must never delay task startup.
        void this.titles.requestTitle(threadId, visibleContent);
      }
      return { runId };
    } catch (error) {
      if (preparedHandle && preparedHandle.active === preparedActive)
        preparedHandle.active = undefined;
      this.broker.cancelThread(threadId);
      this.reservedThreads.delete(threadId);
      throw error;
    } finally {
      if (this.setupBarriers.get(threadId) === setupBarrier)
        this.setupBarriers.delete(threadId);
      if (this.setupControllers.get(threadId) === setupController)
        this.setupControllers.delete(threadId);
      releaseSetup();
    }
  }

  recoverUntitledThreadTitles(): void {
    this.titles.recoverDefaultTitles();
  }

  async cancelRun(threadId: string): Promise<void> {
    const setup = this.setupControllers.get(threadId);
    if (setup && !setup.signal.aborted) {
      setup.abort(
        new DOMException("Desktop run setup cancelled", "AbortError"),
      );
      return;
    }
    const handle = this.handles.get(threadId);
    if (!handle?.active) return;
    this.broker.cancelThread(threadId);
    handle.agent.interrupt("desktop-user-cancelled");
  }

  async resolveApproval(
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    await this.broker.resolve(approvalId, decision);
  }

  async setProcessDisclosure(
    threadId: string,
    runId: string,
    disclosure: "expanded" | "collapsed",
  ): Promise<void> {
    const active = this.handles.get(threadId)?.active;
    const timeline = active?.timeline ?? this.store.getTimeline(threadId);
    const item = timeline.items.find(
      (entry) => entry.type === "assistant" && entry.runId === runId,
    );
    if (!item || item.type !== "assistant")
      throw new Error(`Unknown run: ${runId}`);
    item.processDisclosure = disclosure;
    item.processUserOverride = true;
    await this.store.saveTimeline(timeline);
  }

  async clearContext(
    threadId: string,
  ): Promise<{ thread: ThreadRecord; timeline: ThreadTimeline }> {
    if (this.reservedThreads.has(threadId)) {
      throw new Error("Stop the active run before clearing its context");
    }
    const thread = this.requireThread(threadId);
    const handle = this.handles.get(threadId);
    if (handle?.active || handle?.agent.isRunning) {
      throw new Error("Stop the active run before clearing its context");
    }
    this.titles.reset(threadId);
    if (handle) {
      this.handles.delete(threadId);
      await handle.agent.dispose();
    }
    this.broker.cancelThread(threadId);

    const previousSessionId = thread.sessionId;
    const reset = await this.store.resetThreadContext(threadId);
    const runtimeRoot = resolve(this.runtimeRoot);
    const threadRuntime = resolve(runtimeRoot, threadId);
    const threadRelative = relative(runtimeRoot, threadRuntime);
    const sessionsRoot = resolve(threadRuntime, "sessions");
    const previousSessionPath = resolve(sessionsRoot, previousSessionId);
    const sessionRelative = relative(sessionsRoot, previousSessionPath);
    if (
      threadRelative &&
      threadRelative !== "." &&
      threadRelative !== ".." &&
      !threadRelative.startsWith(`..${sep}`) &&
      !threadRelative.includes(sep) &&
      !isAbsolute(threadRelative) &&
      sessionRelative &&
      sessionRelative !== "." &&
      sessionRelative !== ".." &&
      !sessionRelative.startsWith(`..${sep}`) &&
      !sessionRelative.includes(sep) &&
      !isAbsolute(sessionRelative)
    ) {
      await rm(previousSessionPath, { recursive: true, force: true }).catch(
        (error) => {
          console.warn(
            "Could not remove the previous task session after clearing context:",
            error instanceof Error ? error.message : error,
          );
        },
      );
    }
    return reset;
  }

  async compactContext(threadId: string): ReturnType<Agent["compact"]> {
    if (this.reservedThreads.has(threadId)) {
      throw new Error("Stop the active run before compacting its context");
    }
    const thread = this.requireThread(threadId);
    const handle = await this.ensureHandle(thread);
    if (handle.active || handle.agent.isRunning) {
      throw new Error("Stop the active run before compacting its context");
    }
    const result = await handle.agent.compact();
    const timeline = this.store.getTimeline(threadId);
    timeline.contextWindow = {
      usedTokens: result.afterTokens,
      inputTokens: result.afterTokens,
      outputTokens: 0,
      ...(timeline.contextWindow?.maxTokens !== undefined
        ? { maxTokens: timeline.contextWindow.maxTokens }
        : {}),
      source: "estimated-history",
      updatedAt: new Date().toISOString(),
    };
    await this.store.saveTimeline(timeline);
    return result;
  }

  async deleteThread(threadId: string): Promise<void> {
    this.titles.cancel(threadId);
    this.setupControllers
      .get(threadId)
      ?.abort(new DOMException("Task deleted during setup", "AbortError"));
    await this.setupBarriers.get(threadId);
    const handle = this.handles.get(threadId);
    if (handle?.active) {
      await this.cancelRun(threadId);
      await waitForRunToStop(
        handle.active.done.catch(() => undefined),
        DELETE_RUN_WAIT_MS,
      );
    }
    if (handle) await handle.agent.dispose();
    this.handles.delete(threadId);
    this.reservedThreads.delete(threadId);
    this.broker.cancelThread(threadId);
    const runtimePath = resolve(this.runtimeRoot, threadId);
    const runtimeRelative = relative(resolve(this.runtimeRoot), runtimePath);
    if (
      !runtimeRelative ||
      runtimeRelative === "." ||
      runtimeRelative === ".." ||
      runtimeRelative.startsWith(`..${sep}`) ||
      runtimeRelative.includes(sep) ||
      isAbsolute(runtimeRelative)
    ) {
      throw new Error(
        "Refusing to delete a runtime directory outside Walle's data root",
      );
    }
    await rm(runtimePath, { recursive: true, force: true });
    await this.store.deleteThread(threadId);
  }

  async invalidateThread(threadId: string): Promise<void> {
    this.setupControllers
      .get(threadId)
      ?.abort(
        new DOMException("Runtime invalidated during setup", "AbortError"),
      );
    await this.setupBarriers.get(threadId);
    const handle = this.handles.get(threadId);
    if (!handle) return;
    if (handle.active) {
      handle.stale = true;
      return;
    }
    this.handles.delete(threadId);
    await handle.agent.dispose();
  }

  async invalidateAll(): Promise<void> {
    for (const controller of this.setupControllers.values()) {
      if (!controller.signal.aborted)
        controller.abort(
          new DOMException("Runtime settings changed", "AbortError"),
        );
    }
    await Promise.all([...this.setupBarriers.values()]);
    await Promise.all(
      [...this.handles.keys()].map((threadId) =>
        this.invalidateThread(threadId),
      ),
    );
  }

  async listSkills(threadId?: string): Promise<SkillSummary[]> {
    const threads = threadId
      ? [this.requireThread(threadId)]
      : this.store.listThreads();
    const settings = this.store.getSettings();
    const byId = new Map<string, SkillSummary>();
    for (const thread of threads) {
      const plugin =
        this.handles.get(thread.id)?.skills ??
        new SkillsPlugin({
          project: join(thread.workspaceRoot, ".agents"),
          user: settings.userSkillsDirectory,
        });
      await plugin.registry.loadAll();
      for (const skill of plugin.registry.list())
        byId.set(`${skill.scope}:${skill.id}`, skillSummary(skill));
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async listEvolutionProposals(
    threadId?: string,
  ): Promise<EvolutionProposalSummary[]> {
    const threads = threadId
      ? [this.requireThread(threadId)]
      : this.store.listThreads();
    const results: EvolutionProposalSummary[] = [];
    for (const thread of threads) {
      const plugin =
        this.handles.get(thread.id)?.evolution ??
        new EvolutionPlugin({
          rootDir: this.evolutionRoot(thread.id),
        });
      const proposals = await plugin.proposalStore.list();
      results.push(
        ...proposals.map((proposal) => proposalSummary(proposal, thread.id)),
      );
    }
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async resolveEvolutionProposal(
    threadId: string,
    proposalId: string,
    decision: "approve" | "reject",
  ): Promise<void> {
    const thread = this.requireThread(threadId);
    if (decision === "reject") {
      const plugin =
        this.handles.get(thread.id)?.evolution ??
        new EvolutionPlugin({
          rootDir: this.evolutionRoot(thread.id),
        });
      const result = await plugin.reject(proposalId);
      if (!result) throw new Error(`Unknown Evolution proposal: ${proposalId}`);
      return;
    }
    if (!this.store.getSettings().capabilities.evolution) {
      throw new Error(
        "Enable Evolution before approving and applying a proposal. You can reject it while Evolution is disabled.",
      );
    }
    const handle = await this.ensureHandle(thread);
    if (!handle.evolution)
      throw new Error("Enable Evolution before reviewing its proposals");
    const result = await handle.evolution.approveAndApply(proposalId);
    if (!result) throw new Error(`Unknown Evolution proposal: ${proposalId}`);
  }

  async dispose(): Promise<void> {
    const titleDisposal = this.titles.dispose();
    this.broker.cancelAll();
    for (const controller of this.setupControllers.values()) {
      if (!controller.signal.aborted)
        controller.abort(new DOMException("Desktop shutdown", "AbortError"));
    }
    await Promise.all([...this.setupBarriers.values()]);
    this.broker.cancelAll();
    for (const handle of this.handles.values())
      handle.agent.interrupt("desktop-shutdown");
    await Promise.all(
      [...this.handles.values()].map(async (handle) => {
        await handle.active?.done.catch(() => undefined);
        await handle.agent.dispose();
      }),
    );
    this.handles.clear();
    this.reservedThreads.clear();
    await titleDisposal;
  }

  private async executeRun(
    thread: ThreadRecord,
    handle: AgentHandle,
    active: ActiveDesktopRun,
    prompt: string,
    attachments: Attachment[] = [],
  ): Promise<void> {
    try {
      const stream = handle.agent.run(
        {
          content: prompt,
          attachments,
          sessionId: thread.sessionId,
          metadata: { desktopRunId: active.runId, threadId: thread.id },
        },
        { stream: true, sessionId: thread.sessionId },
      );
      for await (const coreEvent of stream) {
        for (const event of active.normalizer.consume(coreEvent)) {
          if (event.type === "context.updated") {
            active.timeline.contextWindow = structuredClone(
              event.payload as ContextWindowSnapshot,
            );
          }
          this.emit(event);
        }
        this.scheduleTimelinePersist(active);
      }
    } catch (error) {
      for (const event of active.normalizer.consume({ type: "error", error }))
        this.emit(event);
      for (const event of active.normalizer.consume({
        type: "run_end",
        status: "error",
        error,
      }))
        this.emit(event);
    } finally {
      if (active.persistTimer) clearTimeout(active.persistTimer);
      let finalizationError: unknown;
      try {
        await this.store.saveTimeline(active.timeline);
      } catch (error) {
        finalizationError = error;
      }
      try {
        const status =
          active.normalizer.assistant.status === "error" ? "error" : "idle";
        await this.store.updateThread(thread.id, { status });
      } catch (error) {
        finalizationError ??= error;
      } finally {
        handle.active = undefined;
        this.reservedThreads.delete(thread.id);
        if (handle.stale) {
          this.handles.delete(thread.id);
          try {
            await handle.agent.dispose();
          } catch (error) {
            finalizationError ??= error;
          }
        }
      }
      if (
        !finalizationError &&
        active.normalizer.assistant.status === "completed" &&
        this.onRunCompleted
      ) {
        try {
          await this.onRunCompleted({
            threadId: thread.id,
            runId: active.runId,
            completedAt:
              active.normalizer.assistant.completedAt ??
              new Date().toISOString(),
          });
        } catch (error) {
          console.warn(
            "Could not publish the completed task notification:",
            error instanceof Error ? error.message : error,
          );
        }
      }
      if (finalizationError) throw finalizationError;
    }
  }

  private scheduleTimelinePersist(active: ActiveDesktopRun): void {
    if (active.persistTimer) return;
    active.persistTimer = setTimeout(() => {
      active.persistTimer = undefined;
      void this.store.saveTimeline(active.timeline).catch(() => undefined);
    }, 50);
  }

  private async ensureHandle(
    thread: ThreadRecord,
    setupSignal?: AbortSignal,
  ): Promise<AgentHandle> {
    if (setupSignal?.aborted) {
      throw setupSignal.reason instanceof Error
        ? setupSignal.reason
        : new DOMException("Agent setup cancelled", "AbortError");
    }
    const settings = this.store.getSettings();
    const signature = runtimeSignature(thread, settings);
    const existing = this.handles.get(thread.id);
    if (existing?.signature === signature) return existing;
    if (existing?.active)
      throw new Error(
        "Runtime settings changed; wait for the current run to finish",
      );
    if (existing) {
      this.handles.delete(thread.id);
      await existing.agent.dispose();
    }

    const { model, profile } = this.providers.createModel(
      thread.providerProfileId,
    );
    const root = join(this.runtimeRoot, thread.id);
    const memory = new MemoryPlugin({
      rootDir: root,
      sessions: { enabled: true },
      longTerm: { enabled: settings.capabilities.memory },
    });
    const plugins: WallePlugin[] = [memory];
    let skills: SkillsPlugin | undefined;
    let evolution: EvolutionPlugin | undefined;
    let mcpInvalidated = false;

    if (settings.capabilities.skills) {
      skills = new SkillsPlugin({
        project: join(thread.workspaceRoot, ".agents"),
        user: settings.userSkillsDirectory,
      });
      plugins.push(skills);
    }
    if (settings.capabilities.evolution) {
      evolution = new EvolutionPlugin({
        rootDir: this.evolutionRoot(thread.id),
        reviewModel: model,
        periodicReview: {
          enabled: true,
          everyTurns: settings.capabilities.evolutionEveryTurns,
        },
        taskReview: {
          enabled: true,
          minToolCalls: settings.capabilities.evolutionMinToolCalls,
        },
        memoryCreation: {
          enabled: settings.capabilities.memory,
          requireApproval: true,
        },
        skillCreation: {
          enabled: settings.capabilities.skills,
          requireApproval: true,
        },
        onProposal: (proposal) => {
          // Evolution calls observers immediately before its atomic proposal
          // enqueue. Refresh the UI shortly after the callback returns so the
          // list IPC can see the persisted, resolvable proposal id.
          const timer = setTimeout(
            () => this.emitEvolution(thread, proposal),
            100,
          );
          timer.unref?.();
        },
      });
      plugins.push(evolution);
    }

    const workspaceSandbox = await WorkspaceSandbox.create(
      thread.workspaceRoot,
      settings.sandbox,
    );
    plugins.push({
      name: "sandbox",
      version: "desktop-1",
      install(ctx) {
        ctx.registerTool(buildShellTool(workspaceSandbox));
        (ctx as unknown as { __sandbox?: WorkspaceSandbox }).__sandbox =
          workspaceSandbox;
      },
      dispose: () => workspaceSandbox.dispose(),
    });

    if (
      settings.capabilities.rag &&
      settings.capabilities.ragDirectory.trim()
    ) {
      const boundary = await WorkspaceBoundary.create(thread.workspaceRoot);
      const docsPath = await boundary.assertDirectory(
        settings.capabilities.ragDirectory.trim(),
      );
      plugins.push(new SimpleRAGPlugin({ docsPath }));
    }
    if (settings.capabilities.mcp) {
      const servers: MCPServerConfig[] = settings.mcpServers
        .filter((server) => server.enabled)
        .map((server) => {
          if (server.transport === "http") {
            if (!server.url)
              throw new Error(`MCP server “${server.name}” is missing its URL`);
            const url = new URL(server.url);
            if (url.protocol !== "http:" && url.protocol !== "https:") {
              throw new Error(
                `MCP server “${server.name}” must use an HTTP or HTTPS URL`,
              );
            }
            return {
              name: server.name,
              transport: {
                type: "http",
                url: server.url,
                headers: server.headers,
              },
            };
          }
          if (!server.command)
            throw new Error(
              `MCP server “${server.name}” is missing its command`,
            );
          const commandParts = server.args?.length
            ? [server.command]
            : splitCommandLine(server.command);
          if (!commandParts[0])
            throw new Error(
              `MCP server “${server.name}” is missing its executable`,
            );
          return {
            name: server.name,
            transport: {
              type: "stdio",
              command: commandParts[0],
              args: server.args?.length ? server.args : commandParts.slice(1),
              cwd: server.cwd || thread.workspaceRoot,
            },
          };
        });
      if (servers.length)
        plugins.push(
          new MCPPlugin(servers, {
            signal: setupSignal,
            connectTimeoutMs: 30_000,
            listToolsTimeoutMs: 15_000,
            toolCallTimeoutMs: 60_000,
            closeTimeoutMs: 5_000,
            onClientInvalidated: () => {
              mcpInvalidated = true;
              const live = this.handles.get(thread.id);
              if (live) live.stale = true;
            },
          }),
        );
    }
    if (settings.capabilities.trace) {
      plugins.push(
        new TracePlugin({
          store: "jsonl",
          storePath: join(root, "traces"),
          recordContent: settings.capabilities.recordTraceContent,
        }),
      );
    }
    if (settings.capabilities.team) {
      plugins.push(
        new SubAgentsPlugin({
          types: [
            {
              type: "explorer",
              description:
                "Inspect the workspace and report relevant implementation context without changing files.",
              systemPrompt:
                "Explore the requested area carefully. Read code, trace dependencies, and return concise evidence. Do not edit files.",
              model,
              useBuiltinTools: {
                includeTools: ["ls", "read_file", "glob", "grep"],
              },
            },
            {
              type: "reviewer",
              description:
                "Review an implementation for correctness, safety, and missing tests without changing files.",
              systemPrompt:
                "Act as a rigorous code reviewer. Inspect the workspace, identify concrete issues, and return prioritized findings. Do not edit files.",
              model,
              useBuiltinTools: {
                includeTools: ["ls", "read_file", "glob", "grep"],
              },
            },
          ],
        }),
      );
    }

    const interactiveApprovals = settings.permissions.mode !== "auto";
    const approvalToolNames = interactiveApprovals
      ? [
          "forget",
          ...(settings.permissions.approveNetwork ? ["web_fetch"] : []),
        ]
      : [];
    const hasApprovalRules =
      interactiveApprovals &&
      (settings.permissions.approveFileWrites ||
        settings.permissions.approveShell ||
        settings.permissions.approveNetwork ||
        settings.permissions.approveHighRisk ||
        approvalToolNames.length > 0);
    const persistedAllowTools = [...settings.permissions.alwaysAllowTools];
    const policyExemptions: string[] = [];
    if (hasApprovalRules && !settings.permissions.approveFileWrites) {
      policyExemptions.push("write_file", "edit_file");
    }
    if (
      hasApprovalRules &&
      settings.permissions.mode !== "deny-high-risk" &&
      !settings.permissions.approveShell &&
      !settings.permissions.approveNetwork &&
      !settings.permissions.approveHighRisk
    ) {
      policyExemptions.push("shell");
    }
    const permissionPolicy: PermissionPolicy = {
      mode: settings.permissions.mode,
      allowTools: [...new Set([...persistedAllowTools, ...policyExemptions])],
      denyTools: [...settings.permissions.denyTools],
      ...(hasApprovalRules
        ? {
            requireApprovalFor: {
              fileWrite: settings.permissions.approveFileWrites,
              shell: settings.permissions.approveShell,
              network: settings.permissions.approveNetwork,
              riskLevel: settings.permissions.approveHighRisk
                ? ["high" as const]
                : [],
              toolNames: approvalToolNames,
            },
            approvalHandler: async (request) => {
              const current = this.store.getSettings();
              if (
                current.permissions.alwaysAllowTools.includes(
                  request.tool.name,
                ) &&
                canPersistAlwaysAllow({
                  riskLevel: request.riskLevel,
                  tags: request.tool.tags,
                })
              )
                return true;
              const runId = this.handles.get(thread.id)?.active?.runId;
              if (!runId) return false;
              return this.broker.request(thread.id, runId, request);
            },
          }
        : {}),
    };
    const useBuiltinTools = {
      excludeTools: settings.capabilities.team ? ["bash"] : ["bash", "task"],
    };
    const config = {
      name: `Walle · ${thread.title}`,
      description: `Local coding agent for ${thread.workspaceRoot}`,
      sessionId: thread.sessionId,
      workspaceRoot: thread.workspaceRoot,
      model,
      systemPrompt: `${settings.defaultSystemPrompt}\n\nWorkspace root: ${thread.workspaceRoot}\nProvider: ${profile.name} (${profile.model})`,
      plugins,
      permissions: permissionPolicy,
      useBuiltinTools,
      maxTurns: settings.maxTurns,
      tokenBudget: { maxContextTokens: settings.maxContextTokens },
      macroCompression: { enabled: settings.capabilities.macroCompression },
      toolSearch: { enabled: settings.capabilities.toolSearch },
    } satisfies AgentConfig;
    let agent: Agent;
    try {
      agent = await Agent.create(config);
    } catch (error) {
      await Promise.allSettled(plugins.map((plugin) => plugin.dispose?.()));
      throw error;
    }
    const registeredTools = [
      ...agent.listVisibleTools(),
      ...agent.listHiddenTools(),
    ];
    const toolsByName = new Map(
      registeredTools.map((tool) => [tool.name, tool]),
    );
    const safePersistedAllowTools = persistedAllowTools.filter((toolName) => {
      const tool = toolsByName.get(toolName);
      return Boolean(
        tool &&
        canPersistAlwaysAllow({ riskLevel: tool.riskLevel, tags: tool.tags }),
      );
    });
    permissionPolicy.allowTools = [
      ...new Set([...safePersistedAllowTools, ...policyExemptions]),
    ];
    if (
      safePersistedAllowTools.length !== persistedAllowTools.length ||
      safePersistedAllowTools.some(
        (toolName, index) => toolName !== persistedAllowTools[index],
      )
    ) {
      try {
        await this.store.updateSettings({
          permissions: { alwaysAllowTools: safePersistedAllowTools },
        });
      } catch (error) {
        await agent.dispose().catch(() => undefined);
        throw error;
      }
    }
    if (hasApprovalRules && settings.permissions.approveNetwork) {
      const mcpToolNames = registeredTools
        .filter((tool) => tool.tags?.includes("mcp"))
        .map((tool) => tool.name);
      if (mcpToolNames.length) {
        permissionPolicy.requireApprovalFor!.toolNames = [
          ...new Set([
            ...(permissionPolicy.requireApprovalFor!.toolNames ?? []),
            ...mcpToolNames,
          ]),
        ];
      }
    }
    const handle: AgentHandle = {
      signature,
      agent,
      skills,
      evolution,
      stale: mcpInvalidated,
    };
    this.handles.set(thread.id, handle);
    return handle;
  }

  private async onApprovalEvent(event: ApprovalBrokerEvent): Promise<void> {
    const handle = this.handles.get(event.request.threadId);
    const active = handle?.active;
    if (!active || active.runId !== event.request.runId) return;
    if (event.type === "requested") {
      this.emit(active.normalizer.approvalRequested(event.step, event.request));
      await this.store.updateThread(event.request.threadId, {
        status: "approval",
      });
    } else {
      this.emit(
        active.normalizer.approvalResolved(
          event.request.approvalId,
          event.decision,
        ),
      );
      await this.store.updateThread(event.request.threadId, {
        status: "running",
      });
    }
    await this.store.saveTimeline(active.timeline);
  }

  private emitEvolution(
    thread: ThreadRecord,
    proposal: EvolutionProposal,
  ): void {
    const handle = this.handles.get(thread.id);
    const normalizer = handle?.active?.normalizer ?? handle?.lastNormalizer;
    if (normalizer) {
      this.emit(
        normalizer.evolutionProposal(proposalSummary(proposal, thread.id)),
      );
    }
  }

  private evolutionRoot(threadId: string): string {
    return join(this.runtimeRoot, threadId, "evolution");
  }

  private requireThread(threadId: string): ThreadRecord {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error(`Unknown thread: ${threadId}`);
    return thread;
  }
}
