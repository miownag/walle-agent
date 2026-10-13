import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentEventEnvelope,
  BrowserState,
  DesktopApi,
  TerminalDataEvent,
  TerminalExitEvent,
  ThreadAttentionEvent,
  ThreadNavigationRequest,
  ThreadStateEvent,
} from "../shared/contracts";
import { IPC } from "../shared/contracts";

const api: DesktopApi = {
  bootstrap: () => ipcRenderer.invoke(IPC.bootstrap),
  listThreads: () => ipcRenderer.invoke(IPC.threadList),
  createThread: (input) => ipcRenderer.invoke(IPC.threadCreate, input),
  updateThread: (threadId, patch) =>
    ipcRenderer.invoke(IPC.threadUpdate, threadId, patch),
  setActiveThreadIds: (threadIds) =>
    ipcRenderer.invoke(IPC.threadSetActive, threadIds),
  markThreadRead: (threadId) =>
    ipcRenderer.invoke(IPC.threadMarkRead, threadId),
  getPendingThreadAttentions: () =>
    ipcRenderer.invoke(IPC.threadPendingAttentions),
  acknowledgeThreadAttention: (threadId, runId) =>
    ipcRenderer.invoke(IPC.threadAttentionAck, threadId, runId),
  getPendingThreadNavigation: () =>
    ipcRenderer.invoke(IPC.threadPendingNavigation),
  deleteThread: (threadId) => ipcRenderer.invoke(IPC.threadDelete, threadId),
  getTimeline: (threadId) => ipcRenderer.invoke(IPC.threadTimeline, threadId),
  setProcessDisclosure: (threadId, runId, disclosure) =>
    ipcRenderer.invoke(IPC.threadDisclosure, threadId, runId, disclosure),
  startRun: (
    threadId,
    prompt,
    imageAttachments,
    displayPrompt,
    displayParts,
    mode,
  ) =>
    ipcRenderer.invoke(
      IPC.runStart,
      threadId,
      prompt,
      imageAttachments,
      displayPrompt,
      displayParts,
      ...(mode === undefined ? [] : [mode]),
    ),
  updatePendingMessage: (threadId, messageId, action) =>
    ipcRenderer.invoke(IPC.pendingUpdate, threadId, messageId, action),
  cancelRun: (threadId) => ipcRenderer.invoke(IPC.runCancel, threadId),
  clearContext: (threadId) => ipcRenderer.invoke(IPC.contextClear, threadId),
  compactContext: (threadId) =>
    ipcRenderer.invoke(IPC.contextCompact, threadId),
  resolveApproval: (approvalId, decision) =>
    ipcRenderer.invoke(IPC.approvalResolve, approvalId, decision),
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.settingsUpdate, patch),
  upsertProvider: (input) => ipcRenderer.invoke(IPC.providerUpsert, input),
  deleteProvider: (providerId) =>
    ipcRenderer.invoke(IPC.providerDelete, providerId),
  pickWorkspace: () => ipcRenderer.invoke(IPC.workspacePick),
  readDirectory: (workspaceRoot, relativePath) =>
    ipcRenderer.invoke(IPC.workspaceReadDirectory, workspaceRoot, relativePath),
  readFile: (workspaceRoot, relativePath) =>
    ipcRenderer.invoke(IPC.workspaceReadFile, workspaceRoot, relativePath),
  searchWorkspaceFiles: (threadId, query) =>
    ipcRenderer.invoke(IPC.workspaceSearchFiles, threadId, query),
  searchDraftWorkspaceFiles: (workspaceRoot, query) =>
    ipcRenderer.invoke(IPC.workspaceSearchDraftFiles, workspaceRoot, query),
  saveImageAttachments: (threadId, attachments) =>
    ipcRenderer.invoke(
      IPC.workspaceSaveImageAttachments,
      threadId,
      attachments,
    ),
  runCommand: (workspaceRoot, command) =>
    ipcRenderer.invoke(IPC.workspaceRunCommand, workspaceRoot, command),
  createTerminal: (threadId, size) =>
    ipcRenderer.invoke(IPC.terminalCreate, threadId, size),
  writeTerminal: (terminalId, data) => {
    for (let offset = 0; offset < data.length; offset += 64 * 1024) {
      ipcRenderer.send(
        IPC.terminalInput,
        terminalId,
        data.slice(offset, offset + 64 * 1024),
      );
    }
  },
  acknowledgeTerminal: (terminalId, sequence) =>
    ipcRenderer.send(IPC.terminalAck, terminalId, sequence),
  resizeTerminal: (terminalId, size) =>
    ipcRenderer.send(IPC.terminalResize, terminalId, size),
  clearTerminal: (terminalId) =>
    ipcRenderer.send(IPC.terminalClear, terminalId),
  closeTerminal: (terminalId) =>
    ipcRenderer.invoke(IPC.terminalClose, terminalId),
  listSkills: (threadId) => ipcRenderer.invoke(IPC.skillsList, threadId),
  listEvolutionProposals: (threadId) =>
    ipcRenderer.invoke(IPC.evolutionList, threadId),
  resolveEvolutionProposal: (threadId, proposalId, decision) =>
    ipcRenderer.invoke(IPC.evolutionResolve, threadId, proposalId, decision),
  showBrowser: (bounds) => ipcRenderer.invoke(IPC.browserShow, bounds),
  hideBrowser: () => ipcRenderer.invoke(IPC.browserHide),
  setBrowserBounds: (bounds) => ipcRenderer.invoke(IPC.browserBounds, bounds),
  navigateBrowser: (url) => ipcRenderer.invoke(IPC.browserNavigate, url),
  browserBack: () => ipcRenderer.invoke(IPC.browserBack),
  browserForward: () => ipcRenderer.invoke(IPC.browserForward),
  browserReload: () => ipcRenderer.invoke(IPC.browserReload),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  onAgentEvent(listener) {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      payload: AgentEventEnvelope,
    ): void => listener(payload);
    ipcRenderer.on(IPC.agentEvent, wrapped);
    return () => ipcRenderer.removeListener(IPC.agentEvent, wrapped);
  },
  onThreadAttention(listener) {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      payload: ThreadAttentionEvent,
    ): void => listener(payload);
    ipcRenderer.on(IPC.threadAttention, wrapped);
    return () => ipcRenderer.removeListener(IPC.threadAttention, wrapped);
  },
  onThreadNavigation(listener) {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      payload: ThreadNavigationRequest,
    ): void => listener(payload);
    ipcRenderer.on(IPC.threadNavigate, wrapped);
    return () => ipcRenderer.removeListener(IPC.threadNavigate, wrapped);
  },
  onThreadState(listener) {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      payload: ThreadStateEvent,
    ): void => listener(payload);
    ipcRenderer.on(IPC.threadState, wrapped);
    return () => ipcRenderer.removeListener(IPC.threadState, wrapped);
  },
  onBrowserState(listener) {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      payload: BrowserState,
    ): void => listener(payload);
    ipcRenderer.on(IPC.browserState, wrapped);
    return () => ipcRenderer.removeListener(IPC.browserState, wrapped);
  },
  onTerminalData(listener) {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      payload: TerminalDataEvent,
    ): void => listener(payload);
    ipcRenderer.on(IPC.terminalData, wrapped);
    return () => ipcRenderer.removeListener(IPC.terminalData, wrapped);
  },
  onTerminalExit(listener) {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      payload: TerminalExitEvent,
    ): void => listener(payload);
    ipcRenderer.on(IPC.terminalExit, wrapped);
    return () => ipcRenderer.removeListener(IPC.terminalExit, wrapped);
  },
};

contextBridge.exposeInMainWorld("walle", Object.freeze(api));
