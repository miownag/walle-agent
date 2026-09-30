import { useEffect, useRef, useState } from "react";
import {
  IconArrowLeft,
  IconArrowRight,
  IconExternalLink,
  IconLoader2,
  IconRefresh,
  IconWorld,
} from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { normalizeUrl } from "@/lib/format";
import type {
  BrowserBounds,
  BrowserState,
  DesktopApi,
} from "@shared/contracts";

interface BrowserPanelProps {
  api: DesktopApi;
  active: boolean;
}

const initialBrowserState: BrowserState = {
  visible: false,
  url: "about:blank",
  title: "Browser",
  loading: false,
  canGoBack: false,
  canGoForward: false,
};

function boundsFor(element: HTMLElement): BrowserBounds {
  const bounds = element.getBoundingClientRect();
  return {
    x: Math.round(bounds.left),
    y: Math.round(bounds.top),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  };
}

export function BrowserPanel({ api, active }: BrowserPanelProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const [browser, setBrowser] = useState(initialBrowserState);
  const [address, setAddress] = useState("about:blank");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => api.onBrowserState(setBrowser), [api]);

  useEffect(() => {
    if (!editing) setAddress(browser.url || "about:blank");
  }, [browser.url, editing]);

  useEffect(() => {
    const host = hostRef.current;
    if (!active || !host) {
      void api.hideBrowser();
      return;
    }

    const updateBounds = () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = requestAnimationFrame(() => {
        const next = boundsFor(host);
        if (next.width > 0 && next.height > 0) {
          void api.setBrowserBounds(next).catch((cause: unknown) => {
            setError(
              cause instanceof Error
                ? cause.message
                : "Could not resize the browser.",
            );
          });
        }
      });
    };

    const bounds = boundsFor(host);
    void api
      .showBrowser(bounds)
      .then(() => {
        setError("");
        updateBounds();
      })
      .catch((cause: unknown) => {
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not open the browser.",
        );
      });

    const observer = new ResizeObserver(updateBounds);
    observer.observe(host);
    window.addEventListener("resize", updateBounds);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateBounds);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      void api.hideBrowser();
    };
  }, [active, api]);

  const navigate = async () => {
    const url = normalizeUrl(address);
    setAddress(url);
    setEditing(false);
    setError("");
    try {
      await api.navigateBrowser(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Navigation failed.");
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b px-1.5">
        <Button
          size="icon-xs"
          variant="ghost"
          disabled={!browser.canGoBack}
          aria-label="Back"
          onClick={() => void api.browserBack()}
        >
          <IconArrowLeft />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          disabled={!browser.canGoForward}
          aria-label="Forward"
          onClick={() => void api.browserForward()}
        >
          <IconArrowRight />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Reload"
          onClick={() => void api.browserReload()}
        >
          {browser.loading ? (
            <IconLoader2 className="animate-spin" />
          ) : (
            <IconRefresh />
          )}
        </Button>
        <div className="relative min-w-0 flex-1">
          <IconWorld className="absolute left-2 top-1/2 z-10 size-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={address}
            onFocus={() => setEditing(true)}
            onBlur={() => setEditing(false)}
            onChange={(event) => setAddress(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void navigate();
            }}
            className="h-7 rounded-md bg-muted/35 pl-6 pr-2 text-[11px]"
            aria-label="Browser address"
          />
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Open in default browser"
                onClick={() => void api.openExternal(browser.url)}
              />
            }
          >
            <IconExternalLink />
          </TooltipTrigger>
          <TooltipContent>Open externally</TooltipContent>
        </Tooltip>
      </div>

      <div
        ref={hostRef}
        className="relative min-h-0 flex-1 bg-white dark:bg-[#111216]"
      >
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
          {browser.loading ? (
            <span className="flex items-center gap-2">
              <IconLoader2 className="size-4 animate-spin" /> Loading page
            </span>
          ) : (
            "Browser view"
          )}
        </div>
      </div>

      {error && (
        <div className="shrink-0 border-t border-destructive/20 bg-destructive/5 px-3 py-2 text-[10px] text-destructive">
          {error}
        </div>
      )}
    </div>
  );
}
