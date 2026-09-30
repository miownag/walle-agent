import { WebContentsView, type BrowserWindow } from "electron";
import type { BrowserBounds, BrowserState } from "../shared/contracts";

function normalizeUrl(value: string): string {
  const input = value.trim();
  if (!input || input === "about:blank") return "about:blank";
  const withProtocol = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(input)
    ? input
    : `https://${input}`;
  const url = new URL(withProtocol);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The built-in browser only supports HTTP and HTTPS URLs");
  }
  return url.toString();
}

function safeBounds(bounds: BrowserBounds): BrowserBounds {
  for (const value of [bounds.x, bounds.y, bounds.width, bounds.height]) {
    if (!Number.isFinite(value))
      throw new Error("Browser bounds must be finite numbers");
  }
  return {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  };
}

export class BrowserManager {
  private view?: WebContentsView;
  private visible = false;
  private attached = false;
  private bounds: BrowserBounds = { x: 0, y: 0, width: 1, height: 1 };

  constructor(
    private readonly window: BrowserWindow,
    private readonly emit: (state: BrowserState) => void,
  ) {}

  async show(bounds: BrowserBounds): Promise<void> {
    const view = this.ensureView();
    this.bounds = safeBounds(bounds);
    view.setBounds(this.bounds);
    if (!this.attached) {
      this.window.contentView.addChildView(view);
      this.attached = true;
    }
    this.visible = true;
    this.emitState();
  }

  hide(): void {
    if (this.view && this.attached) {
      this.window.contentView.removeChildView(this.view);
      this.attached = false;
    }
    this.visible = false;
    this.emitState();
  }

  setBounds(bounds: BrowserBounds): void {
    this.bounds = safeBounds(bounds);
    this.view?.setBounds(this.bounds);
  }

  async navigate(url: string): Promise<void> {
    await this.ensureView().webContents.loadURL(normalizeUrl(url));
  }

  back(): void {
    const navigation = this.ensureView().webContents.navigationHistory;
    if (navigation.canGoBack()) navigation.goBack();
  }

  forward(): void {
    const navigation = this.ensureView().webContents.navigationHistory;
    if (navigation.canGoForward()) navigation.goForward();
  }

  reload(): void {
    this.ensureView().webContents.reload();
  }

  state(): BrowserState {
    const contents = this.view?.webContents;
    const navigation = contents?.navigationHistory;
    return {
      visible: this.visible,
      url: contents?.getURL() || "about:blank",
      title: contents?.getTitle() || "Browser",
      loading: contents?.isLoading() ?? false,
      canGoBack: navigation?.canGoBack() ?? false,
      canGoForward: navigation?.canGoForward() ?? false,
    };
  }

  dispose(): void {
    this.hide();
    if (this.view && !this.view.webContents.isDestroyed())
      this.view.webContents.close();
    this.view = undefined;
  }

  private ensureView(): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;
    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        partition: "walle-browser",
      },
    });
    view.setBounds(this.bounds);
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.session.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    view.webContents.on("will-navigate", (event, url) => {
      try {
        normalizeUrl(url);
      } catch {
        event.preventDefault();
      }
    });
    view.webContents.on("will-redirect", (event, url) => {
      try {
        normalizeUrl(url);
      } catch {
        event.preventDefault();
      }
    });
    view.webContents.session.on("will-download", (event) =>
      event.preventDefault(),
    );
    view.webContents.on("did-start-loading", () => this.emitState());
    view.webContents.on("did-stop-loading", () => this.emitState());
    view.webContents.on("did-navigate", () => this.emitState());
    view.webContents.on("did-navigate-in-page", () => this.emitState());
    view.webContents.on("page-title-updated", () => this.emitState());
    view.webContents.on("render-process-gone", () => this.emitState());
    this.view = view;
    return view;
  }

  private emitState(): void {
    this.emit(this.state());
  }
}
