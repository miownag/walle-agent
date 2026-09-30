import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import {
  IconInfoCircle,
  IconLoader2,
  IconRefresh,
  IconTerminal2,
  IconTrash,
} from "@tabler/icons-react";
import { useTheme } from "next-themes";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
  DesktopApi,
  TerminalDataEvent,
  TerminalSession,
  TerminalSize,
} from "@shared/contracts";

interface TerminalPanelProps {
  api: DesktopApi;
  threadId: string;
  workspaceName: string;
  active: boolean;
}

interface TerminalController {
  clear(): void;
  focus(): void;
}

interface TerminalCanvasProps extends TerminalPanelProps {
  onController(controller: TerminalController | null): void;
  onSession(session: TerminalSession | null): void;
  onState(state: "connecting" | "running" | "exited" | "error"): void;
}

const MAX_EARLY_TERMINALS = 16;
const MAX_EARLY_INPUT = 64 * 1024;

const ansiPalette = {
  black: "#1e1e1e",
  red: "#f14c4c",
  green: "#23d18b",
  yellow: "#f5f543",
  blue: "#3b8eea",
  magenta: "#d670d6",
  cyan: "#29b8db",
  white: "#e5e7eb",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#ffffff",
} satisfies ITheme;

function terminalTheme(dark: boolean): ITheme {
  return {
    ...ansiPalette,
    background: dark ? "#111216" : "#18191d",
    foreground: "#e5e7eb",
    cursor: "#f0b44b",
    cursorAccent: dark ? "#111216" : "#18191d",
    selectionBackground: "#557bea66",
    selectionInactiveBackground: "#557bea3d",
    scrollbarSliderBackground: "#ffffff24",
    scrollbarSliderHoverBackground: "#ffffff3d",
    scrollbarSliderActiveBackground: "#ffffff52",
  };
}

function codeFontSize(): number {
  const value = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(
      "--code-font-size",
    ),
  );
  return Number.isFinite(value) ? value : 12;
}

function safeError(cause: unknown): string {
  const message =
    cause instanceof Error ? cause.message : "The terminal could not start.";
  return message.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ");
}

function sizeOf(terminal: Terminal): TerminalSize {
  return {
    cols: Math.max(2, Math.min(500, terminal.cols || 80)),
    rows: Math.max(1, Math.min(300, terminal.rows || 24)),
  };
}

function TerminalCanvas({
  api,
  threadId,
  active,
  onController,
  onSession,
  onState,
}: TerminalCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | undefined>(undefined);
  const activeRef = useRef(active);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    activeRef.current = active;
    if (!active) return;
    const terminal = terminalRef.current;
    const fit = fitRef.current;
    if (!terminal || !fit || !containerRef.current?.clientWidth) return;
    requestAnimationFrame(() => {
      try {
        fit.fit();
        if (terminalIdRef.current)
          api.resizeTerminal(terminalIdRef.current, sizeOf(terminal));
        terminal.focus();
      } catch {
        // A tab or dock can be hidden between scheduling and fitting.
      }
    });
  }, [active, api]);

  useEffect(() => {
    if (terminalRef.current)
      terminalRef.current.options.theme = terminalTheme(
        resolvedTheme === "dark",
      );
  }, [resolvedTheme]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let acceptingInput = true;
    let resizeFrame = 0;
    let earlyInput = "";
    const earlyOutput = new Map<string, TerminalDataEvent>();
    const earlyExits = new Map<string, { exitCode: number; signal?: number }>();
    const terminal = new Terminal({
      allowTransparency: false,
      altClickMovesCursor: true,
      cursorBlink: true,
      cursorInactiveStyle: "outline",
      cursorStyle: "block",
      fontFamily:
        '"SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: codeFontSize(),
      fontWeight: "400",
      fontWeightBold: "600",
      letterSpacing: 0,
      lineHeight: 1.22,
      macOptionIsMeta: true,
      minimumContrastRatio: 4.5,
      rightClickSelectsWord: true,
      scrollback: 10_000,
      smoothScrollDuration:
        document.documentElement.classList.contains("reduce-motion") ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? 0
          : 100,
      theme: terminalTheme(resolvedTheme === "dark"),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    terminalRef.current = terminal;
    fitRef.current = fit;
    if (container.clientWidth && container.clientHeight) fit.fit();

    const writeExit = (exitCode: number, signal?: number): void => {
      acceptingInput = false;
      terminalIdRef.current = undefined;
      terminal.writeln("");
      terminal.write(
        `\u001b[90m[process exited with code ${exitCode}${signal === undefined ? "" : `, signal ${signal}`}]\u001b[0m`,
      );
      onState("exited");
    };

    const writeData = (event: TerminalDataEvent): void => {
      terminal.write(event.data, () => {
        api.acknowledgeTerminal(event.terminalId, event.sequence);
      });
    };

    const removeDataListener = api.onTerminalData((event) => {
      if (event.threadId !== threadId) return;
      if (event.terminalId === terminalIdRef.current) {
        writeData(event);
        return;
      }
      if (terminalIdRef.current) return;
      if (
        earlyOutput.has(event.terminalId) ||
        earlyOutput.size < MAX_EARLY_TERMINALS
      ) {
        earlyOutput.set(event.terminalId, event);
      }
    });
    const removeExitListener = api.onTerminalExit((event) => {
      if (event.threadId !== threadId) return;
      if (event.terminalId === terminalIdRef.current) {
        writeExit(event.exitCode, event.signal);
        return;
      }
      if (!terminalIdRef.current) earlyExits.set(event.terminalId, event);
    });
    const inputSubscription = terminal.onData((data) => {
      if (!acceptingInput) return;
      if (terminalIdRef.current) {
        api.writeTerminal(terminalIdRef.current, data);
      } else if (earlyInput.length < MAX_EARLY_INPUT) {
        earlyInput += data.slice(0, MAX_EARLY_INPUT - earlyInput.length);
      }
    });
    const resizeSubscription = terminal.onResize((size) => {
      if (terminalIdRef.current)
        api.resizeTerminal(terminalIdRef.current, size);
    });
    terminal.attachCustomKeyEventHandler((event) => {
      if (
        event.type === "keydown" &&
        event.metaKey &&
        event.key.toLowerCase() === "k"
      ) {
        terminal.clear();
        if (terminalIdRef.current) api.clearTerminal(terminalIdRef.current);
        return false;
      }
      return true;
    });

    const controller: TerminalController = {
      clear: () => {
        terminal.clear();
        if (terminalIdRef.current) api.clearTerminal(terminalIdRef.current);
      },
      focus: () => terminal.focus(),
    };
    onController(controller);
    onState("connecting");

    const fitAndResize = (): void => {
      if (
        !activeRef.current ||
        !container.clientWidth ||
        !container.clientHeight
      )
        return;
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        try {
          fit.fit();
          if (terminalIdRef.current)
            api.resizeTerminal(terminalIdRef.current, sizeOf(terminal));
        } catch {
          // The panel may have been detached while the observer callback ran.
        }
      });
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(fitAndResize);
    resizeObserver?.observe(container);

    void api
      .createTerminal(threadId, sizeOf(terminal))
      .then((session) => {
        if (disposed) {
          void api.closeTerminal(session.id);
          return;
        }
        const exited = earlyExits.get(session.id);
        terminalIdRef.current = session.id;
        if (earlyInput && !exited) {
          api.writeTerminal(session.id, earlyInput);
          earlyInput = "";
        }
        onSession(session);
        onState("running");
        const buffered = earlyOutput.get(session.id);
        if (buffered) writeData(buffered);
        earlyOutput.clear();
        earlyExits.clear();
        if (exited) writeExit(exited.exitCode, exited.signal);
        fitAndResize();
        if (activeRef.current) terminal.focus();
      })
      .catch((cause) => {
        if (disposed) return;
        acceptingInput = false;
        onState("error");
        terminal.writeln(`\u001b[31m${safeError(cause)}\u001b[0m`);
      });

    return () => {
      disposed = true;
      cancelAnimationFrame(resizeFrame);
      resizeObserver?.disconnect();
      removeDataListener();
      removeExitListener();
      inputSubscription.dispose();
      resizeSubscription.dispose();
      onController(null);
      onSession(null);
      const terminalId = terminalIdRef.current;
      terminalIdRef.current = undefined;
      terminalRef.current = null;
      fitRef.current = null;
      terminal.dispose();
      if (terminalId) void api.closeTerminal(terminalId);
    };
    // A thread change is expressed by this canvas being remounted with a new key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, threadId]);

  return (
    <div
      ref={containerRef}
      className="h-full min-h-0 w-full px-2 py-1.5"
      data-testid="terminal-canvas"
      aria-label="Interactive terminal"
      onMouseDown={() => terminalRef.current?.focus()}
    />
  );
}

export function TerminalPanel({
  api,
  threadId,
  workspaceName,
  active,
}: TerminalPanelProps) {
  const [activated, setActivated] = useState(active);
  const [generation, setGeneration] = useState(0);
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [state, setState] = useState<
    "connecting" | "running" | "exited" | "error"
  >("connecting");
  const controllerRef = useRef<TerminalController | null>(null);

  useEffect(() => {
    if (active) setActivated(true);
  }, [active]);

  const restart = (): void => {
    setSession(null);
    setState("connecting");
    setGeneration((value) => value + 1);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--terminal)] text-[var(--terminal-foreground)]">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-white/8 px-2.5 text-[10px] text-[var(--terminal-muted)]">
        <IconTerminal2 className="size-3.5" />
        <span className="truncate text-white/82">{workspaceName}</span>
        {session && <span aria-hidden="true">·</span>}
        {session && (
          <span>
            {session.sandboxKind === "docker" ? "Docker" : "Local host"}
          </span>
        )}
        {session?.shell && (
          <span className="text-white/45">{session.shell}</span>
        )}
        {session?.notice && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="rounded text-white/45 hover:text-white/80"
                  aria-label="Terminal security boundary"
                >
                  <IconInfoCircle className="size-3.5" />
                </button>
              }
            />
            <TooltipContent className="max-w-72">
              {session.notice}
            </TooltipContent>
          </Tooltip>
        )}
        <span
          className="ml-auto flex items-center gap-1.5"
          data-terminal-state={state}
        >
          {state === "connecting" && (
            <IconLoader2 className="size-3 animate-spin" />
          )}
          {state === "error"
            ? "Unavailable"
            : state === "exited"
              ? "Exited"
              : state === "connecting"
                ? "Starting"
                : "Running"}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-[var(--terminal-muted)] hover:bg-white/8 hover:text-white"
          aria-label="Restart terminal"
          onClick={restart}
          disabled={!activated}
        >
          <IconRefresh />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-[var(--terminal-muted)] hover:bg-white/8 hover:text-white"
          aria-label="Clear terminal"
          onClick={() => {
            controllerRef.current?.clear();
            controllerRef.current?.focus();
          }}
          disabled={!activated}
        >
          <IconTrash />
        </Button>
      </div>

      <div className="min-h-0 flex-1" data-terminal-editor>
        {activated ? (
          <TerminalCanvas
            key={`${threadId}:${generation}`}
            api={api}
            threadId={threadId}
            workspaceName={workspaceName}
            active={active}
            onController={(controller) => {
              controllerRef.current = controller;
            }}
            onSession={setSession}
            onState={setState}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-5 text-center text-[11px] text-[var(--terminal-muted)]">
            Open Terminal to start an interactive shell in this workspace.
          </div>
        )}
      </div>
    </div>
  );
}
