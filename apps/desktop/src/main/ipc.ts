import {
  dialog,
  ipcMain,
  shell,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import type {
  BrowserBounds,
  CreateThreadInput,
  DeepPartial,
  AppSettings,
  ImageAttachmentInput,
  ProviderProfileInput,
  SavedImageAttachment,
  TerminalSize,
  UpdateThreadInput,
  UserMessagePart,
} from "../shared/contracts";
import {
  IPC,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES,
} from "../shared/contracts";
import { AgentManager } from "./agent-manager";
import { BrowserManager } from "./browser-manager";
import { capabilityStatuses } from "./defaults";
import { DesktopStore } from "./desktop-store";
import { ProviderService } from "./provider-service";
import { TerminalManager } from "./terminal-manager";
import { ThreadNotificationManager } from "./thread-notification-manager";
import { WorkspaceService } from "./workspace-service";

interface IpcDependencies {
  store: DesktopStore;
  providers: ProviderService;
  agents: AgentManager;
  terminals: TerminalManager;
  threadNotifications: ThreadNotificationManager;
  workspace: WorkspaceService;
  getWindow(): BrowserWindow | null;
  getBrowser(): BrowserManager | null;
  appVersion: string;
  onSettingsChanged(settings: AppSettings): void;
}

function stringArg(value: unknown, name: string, maxLength = 16_384): string {
  if (typeof value !== "string" || !value || value.length > maxLength)
    throw new Error(`Invalid ${name}`);
  return value;
}

function objectArg<T extends object>(value: unknown, name: string): T {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${name}`);
  return value as T;
}

function assertTrusted(
  event: IpcMainInvokeEvent | IpcMainEvent,
  deps: IpcDependencies,
): void {
  const window = deps.getWindow();
  if (
    !window ||
    window.isDestroyed() ||
    event.sender.id !== window.webContents.id
  ) {
    throw new Error("IPC request did not originate from the Walle renderer");
  }
}

function terminalSizeArg(value: unknown): TerminalSize {
  const size = objectArg<Partial<TerminalSize>>(value, "terminal size");
  if (!Number.isInteger(size.cols) || !Number.isInteger(size.rows))
    throw new Error("Invalid terminal size");
  const cols = size.cols as number;
  const rows = size.rows as number;
  if (cols < 2 || cols > 500 || rows < 1 || rows > 300)
    throw new Error("Terminal size is out of range");
  return { cols, rows };
}

function positiveIntegerArg(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new Error(`Invalid ${name}`);
  return value as number;
}

function threadIdsArg(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 2) {
    throw new Error("Invalid active thread ids");
  }
  const result = value.map((entry) =>
    stringArg(entry, "active thread id", 256),
  );
  return [...new Set(result)];
}

function attachmentInputsArg(value: unknown): ImageAttachmentInput[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > MAX_IMAGE_ATTACHMENTS
  ) {
    throw new Error("Invalid image attachments");
  }
  const maxBase64Length = 4 * Math.ceil(MAX_IMAGE_ATTACHMENT_BYTES / 3);
  const inputs = value.map((entry) => {
    const input = objectArg<Record<string, unknown>>(entry, "image attachment");
    return {
      mimeType: stringArg(
        input.mimeType,
        "image attachment MIME type",
        64,
      ) as ImageAttachmentInput["mimeType"],
      base64: stringArg(input.base64, "image attachment data", maxBase64Length),
    };
  });
  const maxAggregateBase64Length =
    4 * Math.ceil(MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES / 3) + inputs.length * 4;
  if (
    inputs.reduce((total, input) => total + input.base64.length, 0) >
    maxAggregateBase64Length
  ) {
    throw new Error("Image attachments exceed the total size limit");
  }
  return inputs;
}

function savedImageAttachmentsArg(value: unknown): SavedImageAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_IMAGE_ATTACHMENTS) {
    throw new Error("Invalid saved image attachments");
  }
  const attachments = value.map((entry) => {
    const input = objectArg<Record<string, unknown>>(
      entry,
      "saved image attachment",
    );
    if (
      !Number.isSafeInteger(input.size) ||
      (input.size as number) < 1 ||
      (input.size as number) > MAX_IMAGE_ATTACHMENT_BYTES
    ) {
      throw new Error("Invalid saved image attachment size");
    }
    return {
      path: stringArg(input.path, "saved image attachment path", 16_384),
      relativePath: stringArg(
        input.relativePath,
        "saved image attachment relative path",
        16_384,
      ),
      fileName: stringArg(
        input.fileName,
        "saved image attachment file name",
        512,
      ),
      mimeType: stringArg(
        input.mimeType,
        "saved image attachment MIME type",
        64,
      ) as SavedImageAttachment["mimeType"],
      size: input.size as number,
    };
  });
  if (
    attachments.reduce((total, attachment) => total + attachment.size, 0) >
    MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES
  ) {
    throw new Error("Saved image attachments exceed the total size limit");
  }
  return attachments;
}

function userMessagePartsArg(value: unknown): UserMessagePart[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error("Invalid user message parts");
  }
  let totalTextLength = 0;
  return value.map((entry): UserMessagePart => {
    const part = objectArg<Record<string, unknown>>(entry, "user message part");
    if (part.type === "text") {
      if (typeof part.text !== "string") {
        throw new Error("Invalid user message text part");
      }
      totalTextLength += part.text.length;
      if (totalTextLength > 2_000_000) {
        throw new Error("User message text parts are too large");
      }
      return { type: "text", text: part.text };
    }
    if (part.type !== "file") {
      throw new Error("Invalid user message part type");
    }
    const relativePath = stringArg(
      part.relativePath,
      "user message file path",
      16_384,
    );
    if (
      relativePath.includes("\0") ||
      relativePath.startsWith("/") ||
      /^[a-z]:[\\/]/i.test(relativePath) ||
      relativePath.split(/[\\/]/).includes("..")
    ) {
      throw new Error("Invalid user message file path");
    }
    return {
      type: "file",
      name: stringArg(part.name, "user message file name", 512),
      relativePath,
    };
  });
}

function requireBrowser(deps: IpcDependencies): BrowserManager {
  const browser = deps.getBrowser();
  if (!browser) throw new Error("The browser view is not available");
  return browser;
}

function assertKnownWorkspace(
  deps: IpcDependencies,
  workspaceRoot: string,
): void {
  if (
    !deps.store
      .listThreads()
      .some((thread) => thread.workspaceRoot === workspaceRoot)
  ) {
    throw new Error("Workspace is not attached to a Walle task");
  }
}

export function registerIpcHandlers(deps: IpcDependencies): () => void {
  const channels: string[] = [];
  const pickedWorkspaceRoots = new Set<string>();
  const listeners: Array<{
    channel: string;
    listener: (event: IpcMainEvent, ...args: unknown[]) => void;
  }> = [];
  const handle = <Args extends unknown[], Result>(
    channel: string,
    fn: (...args: Args) => Promise<Result> | Result,
  ): void => {
    channels.push(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      assertTrusted(event, deps);
      return fn(...(args as Args));
    });
  };
  const handleWithEvent = <Args extends unknown[], Result>(
    channel: string,
    fn: (event: IpcMainInvokeEvent, ...args: Args) => Promise<Result> | Result,
  ): void => {
    channels.push(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      assertTrusted(event, deps);
      return fn(event, ...(args as Args));
    });
  };
  const listen = <Args extends unknown[]>(
    channel: string,
    fn: (event: IpcMainEvent, ...args: Args) => void,
  ): void => {
    const listener = (event: IpcMainEvent, ...args: unknown[]): void => {
      try {
        assertTrusted(event, deps);
        fn(event, ...(args as Args));
      } catch (error) {
        console.warn(
          `Rejected ${channel}:`,
          error instanceof Error ? error.message : error,
        );
      }
    };
    listeners.push({ channel, listener });
    ipcMain.on(channel, listener);
  };

  handle(IPC.bootstrap, async () => {
    const settings = deps.providers.settingsForRenderer();
    return {
      settings,
      threads: deps.store.listThreads(),
      capabilities: capabilityStatuses(settings),
      platform: process.platform,
      appVersion: deps.appVersion,
    };
  });
  handle(IPC.threadList, () => deps.store.listThreads());
  handle(IPC.threadCreate, async (raw: unknown) => {
    const input = objectArg<CreateThreadInput>(raw, "thread input");
    let workspaceRoot = input.workspaceRoot;
    if (!workspaceRoot) {
      const window = deps.getWindow();
      if (!window) return null;
      const result = await dialog.showOpenDialog(window, {
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      workspaceRoot = result.filePaths[0];
    }
    const canonical = await deps.workspace.canonicalRoot(
      stringArg(workspaceRoot, "workspace root", 16_384),
    );
    if (input.providerProfileId)
      deps.providers.resolveProfile(input.providerProfileId);
    return deps.store.createThread({ ...input, workspaceRoot: canonical });
  });
  handle(IPC.threadUpdate, async (threadId: unknown, raw: unknown) => {
    const id = stringArg(threadId, "thread id", 256);
    const patch = objectArg<UpdateThreadInput>(raw, "thread patch");
    const before = deps.store.getThread(id);
    const updated = await deps.store.updateThread(id, patch);
    if (before?.providerProfileId !== updated.providerProfileId)
      await deps.agents.invalidateThread(id);
    return updated;
  });
  handle(IPC.threadSetActive, (raw: unknown) => {
    // This renderer state is only a notification hint. Threads can disappear
    // between a pane change and IPC delivery, so stale ids are ignored rather
    // than turning an ordinary task switch into a user-facing error.
    deps.threadNotifications.setActiveThreadIds(
      threadIdsArg(raw).filter((threadId) => deps.store.getThread(threadId)),
    );
  });
  handle(IPC.threadMarkRead, (threadId: unknown) =>
    deps.threadNotifications.markThreadRead(
      stringArg(threadId, "thread id", 256),
    ),
  );
  handle(IPC.threadPendingAttentions, () =>
    deps.threadNotifications.getPendingAttentions(),
  );
  handle(IPC.threadAttentionAck, (threadId: unknown, runId: unknown) =>
    deps.threadNotifications.acknowledgeAttention(
      stringArg(threadId, "thread id", 256),
      stringArg(runId, "run id", 256),
    ),
  );
  handle(IPC.threadPendingNavigation, () =>
    deps.threadNotifications.getPendingNavigation(),
  );
  handle(IPC.threadDelete, async (threadId: unknown) => {
    const id = stringArg(threadId, "thread id", 256);
    await deps.terminals.disposeThread(id);
    await deps.agents.deleteThread(id);
  });
  handle(IPC.threadTimeline, (threadId: unknown) =>
    deps.store.getTimeline(stringArg(threadId, "thread id", 256)),
  );
  handle(
    IPC.threadDisclosure,
    (threadId: unknown, runId: unknown, disclosure: unknown) => {
      if (disclosure !== "expanded" && disclosure !== "collapsed")
        throw new Error("Invalid process disclosure");
      return deps.agents.setProcessDisclosure(
        stringArg(threadId, "thread id", 256),
        stringArg(runId, "run id", 256),
        disclosure,
      );
    },
  );
  handle(
    IPC.runStart,
    async (
      threadId: unknown,
      prompt: unknown,
      rawAttachments?: unknown,
      displayPrompt?: unknown,
      rawDisplayParts?: unknown,
    ) => {
      const id = stringArg(threadId, "thread id", 256);
      const thread = deps.store.getThread(id);
      if (!thread) throw new Error("Unknown thread");
      let modelPrompt = stringArg(prompt, "prompt", 2_000_000);
      let visiblePrompt =
        displayPrompt === undefined
          ? modelPrompt
          : stringArg(displayPrompt, "display prompt", 2_000_000);
      const displayParts = userMessagePartsArg(rawDisplayParts);
      const savedAttachments = savedImageAttachmentsArg(rawAttachments);
      const attachments = await deps.workspace.loadImageAttachments(
        thread.workspaceRoot,
        savedAttachments,
      );
      if (displayParts?.length) {
        modelPrompt = (
          await deps.workspace.expandUserMessageParts(
            thread.workspaceRoot,
            displayParts,
          )
        ).trim();
        visiblePrompt = displayParts
          .map((part) =>
            part.type === "text" ? part.text : `@[${part.relativePath}]`,
          )
          .join("")
          .trim();
        if (!modelPrompt && savedAttachments.length) {
          modelPrompt = "Please inspect the attached image files and help me.";
        }
        if (savedAttachments.length) {
          modelPrompt += `\n\nAttached image files:\n${savedAttachments
            .map((attachment) => `- ${JSON.stringify(attachment.path)}`)
            .join("\n")}`;
        }
      }
      return deps.agents.startRun(
        id,
        modelPrompt,
        attachments,
        visiblePrompt,
        displayParts,
      );
    },
  );
  handle(IPC.runCancel, (threadId: unknown) =>
    deps.agents.cancelRun(stringArg(threadId, "thread id", 256)),
  );
  handle(IPC.contextClear, async (threadId: unknown) => {
    const id = stringArg(threadId, "thread id", 256);
    const reset = await deps.agents.clearContext(id);
    const thread = await deps.threadNotifications.markThreadRead(id);
    return { ...reset, thread };
  });
  handle(IPC.contextCompact, (threadId: unknown) =>
    deps.agents.compactContext(stringArg(threadId, "thread id", 256)),
  );
  handle(IPC.approvalResolve, (approvalId: unknown, decision: unknown) => {
    if (
      decision !== "allow-once" &&
      decision !== "always-allow" &&
      decision !== "deny"
    )
      throw new Error("Invalid approval decision");
    return deps.agents.resolveApproval(
      stringArg(approvalId, "approval id", 256),
      decision,
    );
  });
  handle(IPC.settingsGet, () => deps.providers.settingsForRenderer());
  handle(IPC.settingsUpdate, async (raw: unknown) => {
    const patch = objectArg<DeepPartial<AppSettings>>(raw, "settings patch");
    const { providers: _providers, version: _version, ...safePatch } = patch;
    await deps.store.updateSettings(safePatch);
    await deps.agents.invalidateAll();
    const settings = deps.providers.settingsForRenderer();
    deps.onSettingsChanged(settings);
    return settings;
  });
  handle(IPC.providerUpsert, async (raw: unknown) => {
    const settings = await deps.providers.upsert(
      objectArg<ProviderProfileInput>(raw, "provider input"),
    );
    await deps.agents.invalidateAll();
    return settings;
  });
  handle(IPC.providerDelete, async (providerId: unknown) => {
    const settings = await deps.providers.delete(
      stringArg(providerId, "provider id", 256),
    );
    await deps.agents.invalidateAll();
    return settings;
  });
  handle(IPC.workspacePick, async () => {
    const window = deps.getWindow();
    if (!window) return null;
    const result = await dialog.showOpenDialog(window, {
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const root = await deps.workspace.canonicalRoot(result.filePaths[0]);
    pickedWorkspaceRoots.add(root);
    return root;
  });
  handle(
    IPC.workspaceReadDirectory,
    (workspaceRoot: unknown, relativePath?: unknown) => {
      const root = stringArg(workspaceRoot, "workspace root", 16_384);
      assertKnownWorkspace(deps, root);
      return deps.workspace.readDirectory(
        root,
        relativePath === undefined
          ? ""
          : stringArg(relativePath, "relative path", 16_384),
      );
    },
  );
  handle(
    IPC.workspaceReadFile,
    (workspaceRoot: unknown, relativePath: unknown) => {
      const root = stringArg(workspaceRoot, "workspace root", 16_384);
      assertKnownWorkspace(deps, root);
      return deps.workspace.readFile(
        root,
        stringArg(relativePath, "relative path", 16_384),
      );
    },
  );
  handle(IPC.workspaceSearchFiles, (threadId: unknown, query: unknown) => {
    const id = stringArg(threadId, "thread id", 256);
    if (typeof query !== "string" || query.length > 256) {
      throw new Error("Invalid workspace file query");
    }
    const thread = deps.store.getThread(id);
    if (!thread) throw new Error("Unknown thread");
    return deps.workspace.searchFiles(thread.workspaceRoot, query);
  });
  handle(
    IPC.workspaceSearchDraftFiles,
    (workspaceRoot: unknown, query: unknown) => {
      const root = stringArg(workspaceRoot, "workspace root", 16_384);
      if (typeof query !== "string" || query.length > 256) {
        throw new Error("Invalid workspace file query");
      }
      if (!pickedWorkspaceRoots.has(root)) assertKnownWorkspace(deps, root);
      return deps.workspace.searchFiles(root, query);
    },
  );
  handle(
    IPC.workspaceSaveImageAttachments,
    (threadId: unknown, rawAttachments: unknown) => {
      const id = stringArg(threadId, "thread id", 256);
      const thread = deps.store.getThread(id);
      if (!thread) throw new Error("Unknown thread");
      return deps.workspace.saveImageAttachments(
        thread.workspaceRoot,
        attachmentInputsArg(rawAttachments),
      );
    },
  );
  handle(
    IPC.workspaceRunCommand,
    (workspaceRoot: unknown, command: unknown) => {
      const root = stringArg(workspaceRoot, "workspace root", 16_384);
      assertKnownWorkspace(deps, root);
      return deps.workspace.runCommand(
        root,
        stringArg(command, "command", 1_000_000),
      );
    },
  );
  handleWithEvent(
    IPC.terminalCreate,
    (event, threadId: unknown, rawSize: unknown) => {
      const id = stringArg(threadId, "thread id", 256);
      const thread = deps.store.getThread(id);
      if (!thread) throw new Error("Unknown thread");
      return deps.terminals.create(
        event.sender.id,
        id,
        thread.workspaceRoot,
        terminalSizeArg(rawSize),
      );
    },
  );
  listen(IPC.terminalInput, (event, terminalId: unknown, data: unknown) => {
    deps.terminals.write(
      event.sender.id,
      stringArg(terminalId, "terminal id", 256),
      stringArg(data, "terminal input", 64 * 1024),
    );
  });
  listen(IPC.terminalAck, (event, terminalId: unknown, sequence: unknown) => {
    deps.terminals.acknowledge(
      event.sender.id,
      stringArg(terminalId, "terminal id", 256),
      positiveIntegerArg(sequence, "terminal output sequence"),
    );
  });
  listen(IPC.terminalResize, (event, terminalId: unknown, rawSize: unknown) => {
    deps.terminals.resize(
      event.sender.id,
      stringArg(terminalId, "terminal id", 256),
      terminalSizeArg(rawSize),
    );
  });
  listen(IPC.terminalClear, (event, terminalId: unknown) => {
    deps.terminals.clear(
      event.sender.id,
      stringArg(terminalId, "terminal id", 256),
    );
  });
  handleWithEvent(IPC.terminalClose, (event, terminalId: unknown) =>
    deps.terminals.close(
      event.sender.id,
      stringArg(terminalId, "terminal id", 256),
    ),
  );
  handle(IPC.skillsList, (threadId?: unknown) =>
    deps.agents.listSkills(
      threadId === undefined
        ? undefined
        : stringArg(threadId, "thread id", 256),
    ),
  );
  handle(IPC.evolutionList, (threadId?: unknown) =>
    deps.agents.listEvolutionProposals(
      threadId === undefined
        ? undefined
        : stringArg(threadId, "thread id", 256),
    ),
  );
  handle(
    IPC.evolutionResolve,
    (threadId: unknown, proposalId: unknown, decision: unknown) => {
      if (decision !== "approve" && decision !== "reject")
        throw new Error("Invalid Evolution decision");
      return deps.agents.resolveEvolutionProposal(
        stringArg(threadId, "thread id", 256),
        stringArg(proposalId, "proposal id", 256),
        decision,
      );
    },
  );
  handle(IPC.browserShow, (raw: unknown) =>
    requireBrowser(deps).show(objectArg<BrowserBounds>(raw, "browser bounds")),
  );
  handle(IPC.browserHide, () => requireBrowser(deps).hide());
  handle(IPC.browserBounds, (raw: unknown) =>
    requireBrowser(deps).setBounds(
      objectArg<BrowserBounds>(raw, "browser bounds"),
    ),
  );
  handle(IPC.browserNavigate, (url: unknown) =>
    requireBrowser(deps).navigate(stringArg(url, "browser URL", 32_768)),
  );
  handle(IPC.browserBack, () => requireBrowser(deps).back());
  handle(IPC.browserForward, () => requireBrowser(deps).forward());
  handle(IPC.browserReload, () => requireBrowser(deps).reload());
  handle(IPC.openExternal, async (rawUrl: unknown) => {
    const url = new URL(stringArg(rawUrl, "external URL", 32_768));
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error("Only HTTP and HTTPS links can be opened externally");
    await shell.openExternal(url.toString());
  });

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
    for (const { channel, listener } of listeners)
      ipcMain.removeListener(channel, listener);
  };
}
