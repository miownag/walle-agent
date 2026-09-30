import {
  IconColumns2,
  IconLayoutSidebar,
  IconLayoutSidebarRight,
  IconPlus,
} from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ThreadRecord } from "@shared/contracts";

interface TitlebarProps {
  page?: "conversation" | "settings" | "evolution";
  activeThread?: ThreadRecord;
  draftOpen?: boolean;
  threads: ThreadRecord[];
  paneIds: string[];
  dockOpen: boolean;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onAddSplit: (threadId: string) => void;
  onToggleDock: () => void;
}

export function Titlebar({
  page = "conversation",
  activeThread,
  draftOpen = false,
  threads,
  paneIds,
  dockOpen,
  sidebarOpen,
  onToggleSidebar,
  onAddSplit,
  onToggleDock,
}: TitlebarProps) {
  const utilityPage = page !== "conversation";
  const splitCandidates = threads.filter(
    (thread) => !thread.archived && !paneIds.includes(thread.id),
  );

  return (
    <header
      className={cn(
        "app-drag-region relative z-50 grid h-12 shrink-0 bg-background transition-[grid-template-columns,background-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
        sidebarOpen
          ? "grid-cols-[276px_minmax(0,1fr)] max-[860px]:grid-cols-[128px_minmax(0,1fr)]"
          : "grid-cols-[128px_minmax(0,1fr)]",
      )}
      data-sidebar-state={sidebarOpen ? "open" : "closed"}
      data-page={page}
    >
      <div
        data-slot="titlebar-sidebar-controls"
        className={cn(
          "flex items-center pl-[92px] transition-[background-color,box-shadow] duration-300 motion-reduce:transition-none",
          sidebarOpen &&
            "walle-divider-right border-r border-sidebar-border bg-sidebar max-[860px]:border-r-0 max-[860px]:bg-background max-[860px]:shadow-none",
        )}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="app-no-drag size-8 text-muted-foreground hover:text-foreground"
                aria-label="Toggle sidebar"
                aria-pressed={sidebarOpen}
                onClick={onToggleSidebar}
              />
            }
          >
            <IconLayoutSidebar className="size-5" stroke={1.75} />
          </TooltipTrigger>
          <TooltipContent side="bottom">Toggle sidebar</TooltipContent>
        </Tooltip>
      </div>

      <div
        data-slot="titlebar-main"
        className="walle-divider-bottom flex min-w-0 items-center gap-1 border-b border-[var(--divider)] px-3"
      >
        <div className="min-w-0 flex-1 text-center">
          {utilityPage ? (
            <span className="text-xs font-medium text-foreground/85">
              {page === "settings" ? "Settings" : "Evolution"}
            </span>
          ) : activeThread ? (
            <div className="mx-auto max-w-[55vw] truncate text-xs font-medium text-foreground/85">
              {activeThread.title}
              <span className="ml-2 hidden font-normal text-muted-foreground md:inline">
                {activeThread.workspaceName}
              </span>
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">Walle</span>
          )}
        </div>

        {!utilityPage && !draftOpen && (
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="app-no-drag size-8"
                        aria-label="Split conversation"
                        disabled={
                          paneIds.length >= 2 || splitCandidates.length === 0
                        }
                      />
                    }
                  />
                }
              >
                <IconColumns2 className="size-[19px]" />
              </TooltipTrigger>
              <TooltipContent side="bottom">
                Open a thread side by side
              </TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Open side by side</DropdownMenuLabel>
                {splitCandidates.slice(0, 12).map((thread) => (
                  <DropdownMenuItem
                    key={thread.id}
                    onClick={() => onAddSplit(thread.id)}
                  >
                    <IconPlus className="size-3.5" />
                    <span className="min-w-0 flex-1 truncate">
                      {thread.title}
                    </span>
                    <span className="max-w-20 truncate text-[10px] text-muted-foreground">
                      {thread.workspaceName}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {!utilityPage && !draftOpen && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={cn(
                    "app-no-drag size-8 text-muted-foreground hover:text-foreground",
                    dockOpen && "bg-muted text-foreground",
                  )}
                  aria-label={
                    dockOpen ? "Close developer dock" : "Open developer dock"
                  }
                  aria-pressed={dockOpen}
                  onClick={onToggleDock}
                />
              }
            >
              <IconLayoutSidebarRight className="size-5" stroke={1.75} />
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Files, browser, and terminal
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </header>
  );
}
