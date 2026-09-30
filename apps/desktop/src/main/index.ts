import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import {
  app,
  BrowserWindow,
  nativeTheme,
  Notification,
  safeStorage,
} from "electron";
import type {
  ThreadAttentionEvent,
  ThreadNavigationRequest,
  ThreadStateEvent,
} from "../shared/contracts";
import { IPC } from "../shared/contracts";
import { AgentManager } from "./agent-manager";
import { BrowserManager } from "./browser-manager";
import { DesktopStore } from "./desktop-store";
import { registerIpcHandlers } from "./ipc";
import {
  NotificationService,
  type SystemNotificationHandle,
} from "./notification-service";
import { ProviderSecretStore } from "./provider-secret-store";
import { ProviderService } from "./provider-service";
import { TerminalManager } from "./terminal-manager";
import { ThreadNotificationManager } from "./thread-notification-manager";
import { WorkspaceService } from "./workspace-service";

const currentDir = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let browserManager: BrowserManager | null = null;
let agentManager: AgentManager | null = null;
let desktopStore: DesktopStore | null = null;
let workspaceService: WorkspaceService | null = null;
let terminalManager: TerminalManager | null = null;
let threadNotificationManager: ThreadNotificationManager | null = null;
let unregisterIpc: (() => void) | undefined;
let shuttingDown = false;
const ownsSingleInstance = app.requestSingleInstanceLock();

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function send(channel: string, payload: unknown): void {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    mainWindow.webContents.isDestroyed()
  )
    return;
  mainWindow.webContents.send(channel, payload);
}

function sendToRenderer(
  ownerId: number,
  channel: string,
  payload: unknown,
): void {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    mainWindow.webContents.isDestroyed()
  )
    return;
  if (mainWindow.webContents.id !== ownerId) return;
  mainWindow.webContents.send(channel, payload);
}

function focusMainWindow(): BrowserWindow | null {
  const window = ensureMainWindow();
  if (!window) return null;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return window;
}

function sendThreadNavigation(event: ThreadNavigationRequest): void {
  const window = ensureMainWindow();
  if (!window || window.isDestroyed() || window.webContents.isDestroyed())
    return;
  const deliver = (): void => {
    if (
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      mainWindow !== window
    )
      return;
    window.webContents.send(IPC.threadNavigate, event);
  };
  if (window.webContents.isLoadingMainFrame()) {
    window.webContents.once("did-finish-load", deliver);
  } else {
    deliver();
  }
}

function developmentRendererUrl(): string | undefined {
  const raw = process.env.ELECTRON_RENDERER_URL;
  if (!raw || app.isPackaged) return undefined;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const loopback =
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "127.0.0.1" ||
      host === "[::1]" ||
      host === "::1";
    return (url.protocol === "http:" || url.protocol === "https:") && loopback
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    show: false,
    title: "Walle",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 17 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#18191c" : "#fafafa",
    webPreferences: {
      preload: join(currentDir, "../preload/index.cjs"),
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: true,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  const ownerId = window.webContents.id;
  window.webContents.on("render-process-gone", () => {
    threadNotificationManager?.setActiveThreadIds([]);
    void terminalManager?.disposeOwner(ownerId);
  });
  window.webContents.on(
    "did-start-navigation",
    (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) {
        threadNotificationManager?.setActiveThreadIds([]);
        void terminalManager?.disposeOwner(ownerId);
      }
    },
  );

  const developmentUrl = developmentRendererUrl();
  if (developmentUrl) {
    const allowedOrigin = new URL(developmentUrl).origin;
    window.webContents.on("will-navigate", (event, url) => {
      if (new URL(url).origin !== allowedOrigin) event.preventDefault();
    });
    void window.loadURL(developmentUrl);
  } else {
    const rendererFile = join(currentDir, "../renderer/index.html");
    const rendererUrl = pathToFileURL(rendererFile).toString();
    window.webContents.on("will-navigate", (event, url) => {
      if (url.split(/[?#]/, 1)[0] !== rendererUrl) event.preventDefault();
    });
    void window.loadFile(rendererFile);
  }

  window.once("ready-to-show", () => window.show());
  window.on("focus", () => {
    void threadNotificationManager?.handleWindowFocused().catch((error) => {
      console.warn(
        "Could not reconcile task notifications on focus:",
        error instanceof Error ? error.message : error,
      );
    });
  });
  window.on("closed", () => {
    threadNotificationManager?.setActiveThreadIds([]);
    browserManager?.dispose();
    browserManager = null;
    void terminalManager?.disposeOwner(ownerId);
    if (mainWindow === window) mainWindow = null;
  });
  return window;
}

function ensureMainWindow(): BrowserWindow | null {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  if (!agentManager) return null;
  const window = createWindow();
  mainWindow = window;
  browserManager = new BrowserManager(window, (state) =>
    send(IPC.browserState, state),
  );
  return window;
}

async function bootstrap(): Promise<void> {
  const dataRoot = join(app.getPath("userData"), "walle");
  const store = new DesktopStore(dataRoot);
  await store.init();
  desktopStore = store;
  const secrets = new ProviderSecretStore(dataRoot, safeStorage);
  await secrets.init();
  const providers = new ProviderService(store, secrets);
  const workspace = new WorkspaceService(() => store.getSettings());
  workspaceService = workspace;
  terminalManager = new TerminalManager(() => store.getSettings(), {
    data: (ownerId, event) => sendToRenderer(ownerId, IPC.terminalData, event),
    exit: (ownerId, event) => sendToRenderer(ownerId, IPC.terminalExit, event),
  });
  const notificationService = new NotificationService({
    isSupported: () => Notification.isSupported(),
    create: (options) =>
      new Notification(options) as unknown as SystemNotificationHandle,
  });
  threadNotificationManager = new ThreadNotificationManager(
    store,
    notificationService,
    {
      isWindowFocused: () =>
        Boolean(
          mainWindow &&
          !mainWindow.isDestroyed() &&
          !mainWindow.isMinimized() &&
          mainWindow.isVisible() &&
          mainWindow.isFocused(),
        ),
      focusWindow: () => {
        focusMainWindow();
      },
      sendAttention: (event: ThreadAttentionEvent) =>
        send(IPC.threadAttention, event),
      sendNavigation: sendThreadNavigation,
      sendThreadState: (event) => send(IPC.threadState, event),
    },
  );
  nativeTheme.themeSource = store.getSettings().appearance.theme;

  agentManager = new AgentManager(
    store,
    providers,
    join(dataRoot, "runtime"),
    (event) => send(IPC.agentEvent, event),
    (completion) => threadNotificationManager?.handleRunCompleted(completion),
    (thread) =>
      send(IPC.threadState, {
        thread,
        reason: "title-generated",
      } satisfies ThreadStateEvent),
  );
  agentManager.recoverUntitledThreadTitles();

  ensureMainWindow();
  unregisterIpc = registerIpcHandlers({
    store,
    providers,
    agents: agentManager,
    terminals: terminalManager,
    threadNotifications: threadNotificationManager,
    workspace,
    getWindow: () => mainWindow,
    getBrowser: () => browserManager,
    appVersion: app.getVersion(),
    onSettingsChanged: (settings) => {
      nativeTheme.themeSource = settings.appearance.theme;
      mainWindow?.setBackgroundColor(
        nativeTheme.shouldUseDarkColors ? "#18191c" : "#fafafa",
      );
    },
  });
}

if (!ownsSingleInstance) {
  app.quit();
} else {
  app.on("second-instance", focusMainWindow);
  app
    .whenReady()
    .then(bootstrap)
    .catch((error) => {
      console.error("Failed to start Walle:", error);
      app.quit();
    });
}

app.on("activate", () => {
  focusMainWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  browserManager?.dispose();
  unregisterIpc?.();
  unregisterIpc = undefined;
  void (async () => {
    try {
      await Promise.race([
        Promise.all([
          agentManager?.dispose() ?? Promise.resolve(),
          terminalManager?.dispose() ?? Promise.resolve(),
          workspaceService?.dispose() ?? Promise.resolve(),
        ]),
        delay(8_000),
      ]);
      await desktopStore?.flush();
    } finally {
      app.exit(0);
    }
  })();
});
