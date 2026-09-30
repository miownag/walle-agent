import { useState } from "react";
import {
  IconFiles,
  IconTerminal2,
  IconWorld,
  IconX,
} from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { DesktopApi, ThreadRecord } from "@shared/contracts";
import { BrowserPanel } from "./browser-panel";
import { FilesPanel } from "./files-panel";
import { TerminalPanel } from "./terminal-panel";

type DockTab = "files" | "browser" | "terminal";

interface DeveloperDockProps {
  api: DesktopApi;
  thread: ThreadRecord;
  browserEnabled: boolean;
  onClose: () => void;
}

export function DeveloperDock({
  api,
  thread,
  browserEnabled,
  onClose,
}: DeveloperDockProps) {
  const [tab, setTab] = useState<DockTab>("files");

  return (
    <aside
      className="flex h-full min-w-0 flex-col border-l bg-background"
      aria-label="Developer dock"
    >
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as DockTab)}
        className="min-h-0 flex-1 gap-0"
      >
        <div className="flex h-10 shrink-0 items-center border-b px-2">
          <TabsList variant="line" className="h-8 gap-0 p-0">
            <TabsTrigger value="files" className="h-8 gap-1 px-2 text-[11px]">
              <IconFiles className="size-3.5" /> Files
            </TabsTrigger>
            <TabsTrigger value="browser" className="h-8 gap-1 px-2 text-[11px]">
              <IconWorld className="size-3.5" /> Browser
            </TabsTrigger>
            <TabsTrigger
              value="terminal"
              className="h-8 gap-1 px-2 text-[11px]"
            >
              <IconTerminal2 className="size-3.5" /> Terminal
            </TabsTrigger>
          </TabsList>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="ml-auto"
                  aria-label="Close dock"
                  onClick={onClose}
                />
              }
            >
              <IconX />
            </TooltipTrigger>
            <TooltipContent>Close dock</TooltipContent>
          </Tooltip>
        </div>
        <div className="min-h-0 flex-1">
          <TabsContent value="files" className="h-full min-h-0">
            <FilesPanel api={api} workspaceRoot={thread.workspaceRoot} />
          </TabsContent>
          <TabsContent value="browser" className="h-full min-h-0">
            <BrowserPanel
              api={api}
              active={tab === "browser" && browserEnabled}
            />
          </TabsContent>
          <TabsContent value="terminal" keepMounted className="h-full min-h-0">
            <TerminalPanel
              key={thread.id}
              api={api}
              threadId={thread.id}
              workspaceName={thread.workspaceName}
              active={tab === "terminal"}
            />
          </TabsContent>
        </div>
      </Tabs>
    </aside>
  );
}
