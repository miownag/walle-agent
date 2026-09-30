import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import type {
  DesktopApi,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalSession,
} from "@shared/contracts";
import { TerminalPanel } from "./terminal-panel";

const terminalMocks = vi.hoisted(() => {
  const instances: Array<{
    cols: number;
    rows: number;
    options: Record<string, unknown>;
    writes: string[];
    clears: number;
    focused: number;
    disposed: number;
    flushWrites(): void;
    emitData(data: string): void;
    emitResize(size: { cols: number; rows: number }): void;
  }> = [];
  class MockTerminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    writes: string[] = [];
    clears = 0;
    focused = 0;
    disposed = 0;
    private writeCallbacks: Array<() => void> = [];
    private dataListener?: (data: string) => void;
    private resizeListener?: (size: { cols: number; rows: number }) => void;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      instances.push(this);
    }

    loadAddon(): void {}
    open(): void {}
    focus(): void {
      this.focused += 1;
    }
    clear(): void {
      this.clears += 1;
    }
    dispose(): void {
      this.disposed += 1;
    }
    write(data: string, callback?: () => void): void {
      this.writes.push(data);
      if (callback) this.writeCallbacks.push(callback);
    }
    writeln(data: string): void {
      this.writes.push(`${data}\r\n`);
    }
    attachCustomKeyEventHandler(): void {}
    onData(listener: (data: string) => void) {
      this.dataListener = listener;
      return {
        dispose: () => {
          this.dataListener = undefined;
        },
      };
    }
    onResize(listener: (size: { cols: number; rows: number }) => void) {
      this.resizeListener = listener;
      return {
        dispose: () => {
          this.resizeListener = undefined;
        },
      };
    }
    emitData(data: string): void {
      this.dataListener?.(data);
    }
    flushWrites(): void {
      for (const callback of this.writeCallbacks.splice(0)) callback();
    }
    emitResize(size: { cols: number; rows: number }): void {
      this.resizeListener?.(size);
    }
  }
  return { instances, MockTerminal };
});

vi.mock("@xterm/xterm", () => ({ Terminal: terminalMocks.MockTerminal }));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit(): void {}
  },
}));
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function session(id = "terminal-1"): TerminalSession {
  return {
    id,
    threadId: "thread-1",
    sandboxKind: "local",
    shell: "zsh",
    size: { cols: 80, rows: 24 },
    notice: "Direct user shell on this Mac.",
  };
}

describe("TerminalPanel", () => {
  let dataListeners: Array<(event: TerminalDataEvent) => void>;
  let exitListeners: Array<(event: TerminalExitEvent) => void>;
  let api: DesktopApi;

  beforeEach(() => {
    terminalMocks.instances.length = 0;
    dataListeners = [];
    exitListeners = [];
    api = {
      createTerminal: vi.fn(async () => session()),
      writeTerminal: vi.fn(),
      acknowledgeTerminal: vi.fn(),
      resizeTerminal: vi.fn(),
      clearTerminal: vi.fn(),
      closeTerminal: vi.fn(async () => undefined),
      onTerminalData: vi.fn((listener) => {
        dataListeners.push(listener);
        return () => {
          dataListeners = dataListeners.filter(
            (candidate) => candidate !== listener,
          );
        };
      }),
      onTerminalExit: vi.fn((listener) => {
        exitListeners.push(listener);
        return () => {
          exitListeners = exitListeners.filter(
            (candidate) => candidate !== listener,
          );
        };
      }),
    } as unknown as DesktopApi;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderPanel(active: boolean) {
    return render(
      <TooltipProvider>
        <TerminalPanel
          api={api}
          threadId="thread-1"
          workspaceName="walle-agent"
          active={active}
        />
      </TooltipProvider>,
    );
  }

  it("starts only after activation and presents one editor-like terminal surface", async () => {
    const view = renderPanel(false);
    expect(api.createTerminal).not.toHaveBeenCalled();
    expect(
      screen.queryByPlaceholderText(/run a command/i),
    ).not.toBeInTheDocument();

    view.rerender(
      <TooltipProvider>
        <TerminalPanel
          api={api}
          threadId="thread-1"
          workspaceName="walle-agent"
          active
        />
      </TooltipProvider>,
    );
    await waitFor(() =>
      expect(api.createTerminal).toHaveBeenCalledWith("thread-1", {
        cols: 80,
        rows: 24,
      }),
    );
    expect(screen.getByTestId("terminal-canvas")).toHaveAttribute(
      "aria-label",
      "Interactive terminal",
    );
    expect(await screen.findByText("Local host")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("buffers initial PTY output and user input until create returns", async () => {
    const pending = deferred<TerminalSession>();
    vi.mocked(api.createTerminal).mockReturnValueOnce(pending.promise);
    renderPanel(true);
    await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
    const terminal = terminalMocks.instances[0];

    act(() => {
      dataListeners.forEach((listener) =>
        listener({
          terminalId: "terminal-1",
          threadId: "thread-1",
          sequence: 1,
          data: "prompt> ",
        }),
      );
      terminal.emitData("pwd\r");
    });
    expect(terminal.writes).not.toContain("prompt> ");
    expect(api.writeTerminal).not.toHaveBeenCalled();

    await act(async () => pending.resolve(session()));
    expect(terminal.writes).toContain("prompt> ");
    expect(api.writeTerminal).toHaveBeenCalledWith("terminal-1", "pwd\r");
    expect(api.acknowledgeTerminal).not.toHaveBeenCalled();
    act(() => terminal.flushWrites());
    expect(api.acknowledgeTerminal).toHaveBeenCalledWith("terminal-1", 1);
  });

  it("ACKs live output only after xterm finishes parsing the batch", async () => {
    renderPanel(true);
    await screen.findByText("Running");
    const terminal = terminalMocks.instances[0];

    act(() => {
      dataListeners.forEach((listener) =>
        listener({
          terminalId: "terminal-1",
          threadId: "thread-1",
          sequence: 7,
          data: "many lines\r\n",
        }),
      );
    });
    expect(terminal.writes).toContain("many lines\r\n");
    expect(api.acknowledgeTerminal).not.toHaveBeenCalled();

    act(() => terminal.flushWrites());
    expect(api.acknowledgeTerminal).toHaveBeenCalledWith("terminal-1", 7);
  });

  it("forwards live input and resize, and synchronizes clear with the PTY", async () => {
    renderPanel(true);
    await screen.findByText("Running");
    const terminal = terminalMocks.instances[0];

    act(() => {
      terminal.emitData("printf ok\r");
      terminal.emitResize({ cols: 132, rows: 48 });
    });
    expect(api.writeTerminal).toHaveBeenCalledWith("terminal-1", "printf ok\r");
    expect(api.resizeTerminal).toHaveBeenCalledWith("terminal-1", {
      cols: 132,
      rows: 48,
    });

    fireEvent.click(screen.getByRole("button", { name: "Clear terminal" }));
    expect(terminal.clears).toBe(1);
    expect(api.clearTerminal).toHaveBeenCalledWith("terminal-1");
  });

  it("stops forwarding input after exit and can restart a fresh PTY", async () => {
    renderPanel(true);
    await screen.findByText("Running");
    const first = terminalMocks.instances[0];

    act(() => {
      exitListeners.forEach((listener) =>
        listener({
          terminalId: "terminal-1",
          threadId: "thread-1",
          exitCode: 130,
          signal: 2,
        }),
      );
      first.emitData("ignored\r");
    });
    expect(screen.getByText("Exited")).toBeInTheDocument();
    expect(api.writeTerminal).not.toHaveBeenCalledWith(
      "terminal-1",
      "ignored\r",
    );

    vi.mocked(api.createTerminal).mockResolvedValueOnce(session("terminal-2"));
    fireEvent.click(screen.getByRole("button", { name: "Restart terminal" }));
    await waitFor(() => expect(api.createTerminal).toHaveBeenCalledTimes(2));
    expect(first.disposed).toBe(1);
    expect(await screen.findByText("Running")).toBeInTheDocument();
  });

  it("closes its owned PTY when the dock or thread surface unmounts", async () => {
    const view = renderPanel(true);
    await screen.findByText("Running");

    view.unmount();
    expect(api.closeTerminal).toHaveBeenCalledWith("terminal-1");
  });
});
