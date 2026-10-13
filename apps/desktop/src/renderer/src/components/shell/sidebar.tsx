import { useEffect, useMemo, useState } from "react";
import {
  IconArchive,
  IconArchiveOff,
  IconBolt,
  IconDots,
  IconEdit,
  IconFolder,
  IconFolderOpen,
  IconMessagePlus,
  IconPin,
  IconPinFilled,
  IconSearch,
  IconSettings,
  IconSparkles,
  IconSquareRoundedPlus,
  IconTrash,
  IconX,
} from "@tabler/icons-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/format";
import type { ThreadRecord } from "@shared/contracts";

interface SidebarProps {
  threads: ThreadRecord[];
  draftWorkspaceRoot?: string;
  activeIds: string[];
  evolutionCount: number;
  creating: boolean;
  visible: boolean;
  mobileOpen: boolean;
  unreadThreadIds?: string[];
  onMobileClose: () => void;
  onSelect: (threadId: string) => void;
  onCreate: () => Promise<void>;
  onCreateInWorkspace: (workspaceRoot: string) => Promise<void>;
  onUpdate: (
    threadId: string,
    patch: { title?: string; pinned?: boolean; archived?: boolean },
  ) => Promise<boolean>;
  onDelete: (threadId: string) => Promise<void>;
  onOpenSettings: () => void;
  onOpenEvolution: () => void;
}

function ThreadRow({
  thread,
  active,
  unread,
  onSelect,
  onRename,
  onUpdate,
  onDelete,
}: {
  thread: ThreadRecord;
  active: boolean;
  unread: boolean;
  onSelect: () => void;
  onRename: () => void;
  onUpdate: SidebarProps["onUpdate"];
  onDelete: () => void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <button
          type="button"
          className={cn(
            "group/thread flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/50",
            active
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-sidebar-foreground/82 hover:bg-sidebar-accent/65",
          )}
          onClick={onSelect}
        >
          <span
            aria-hidden="true"
            data-slot="thread-status-dot"
            data-unread={unread || undefined}
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              thread.status === "running" && "animate-pulse bg-[var(--brand)]",
              thread.status === "approval" && "bg-[var(--warning)]",
              thread.status === "error" && "bg-destructive",
              thread.status === "idle" &&
                (unread ? "bg-[var(--info)]" : "bg-transparent"),
            )}
          />
          <span className="min-w-0 flex-1 truncate">{thread.title}</span>
          {unread && <span className="sr-only">Unread</span>}
          {thread.pinned && (
            <IconPinFilled className="size-3 shrink-0 text-muted-foreground/70" />
          )}
          <span
            aria-hidden="true"
            className="hidden shrink-0 text-[10px] text-muted-foreground group-hover/thread:block"
          >
            {formatRelativeTime(thread.updatedAt)}
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem onClick={onRename}>
          <IconEdit /> Rename
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => void onUpdate(thread.id, { pinned: !thread.pinned })}
        >
          <IconPin /> {thread.pinned ? "Unpin" : "Pin"}
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() =>
            void onUpdate(thread.id, { archived: !thread.archived })
          }
        >
          {thread.archived ? <IconArchiveOff /> : <IconArchive />}
          {thread.archived ? "Unarchive" : "Archive"}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={onDelete}>
          <IconTrash /> Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function Sidebar({
  threads,
  draftWorkspaceRoot,
  activeIds,
  evolutionCount,
  creating,
  visible,
  mobileOpen,
  unreadThreadIds = [],
  onMobileClose,
  onSelect,
  onCreate,
  onCreateInWorkspace,
  onUpdate,
  onDelete,
  onOpenSettings,
  onOpenEvolution,
}: SidebarProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [renameThread, setRenameThread] = useState<ThreadRecord | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteThread, setDeleteThread] = useState<ThreadRecord | null>(null);
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(
    () => new Set(),
  );

  const [savedWorkspaceOrder, setSavedWorkspaceOrder] = useState<string[]>(
    () => {
      try {
        const value: unknown = JSON.parse(
          window.localStorage.getItem("walle.sidebar-workspace-order") ?? "[]",
        );
        return Array.isArray(value)
          ? value.filter((root): root is string => typeof root === "string")
          : [];
      } catch {
        return [];
      }
    },
  );
  const workspaceOrder = useMemo(() => {
    const roots = new Set(savedWorkspaceOrder);
    for (const thread of [...threads].sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) ||
        a.workspaceRoot.localeCompare(b.workspaceRoot),
    ))
      roots.add(thread.workspaceRoot);
    if (draftWorkspaceRoot) roots.add(draftWorkspaceRoot);
    return [...roots];
  }, [savedWorkspaceOrder, threads, draftWorkspaceRoot]);
  useEffect(() => {
    if (workspaceOrder.length === savedWorkspaceOrder.length) return;
    setSavedWorkspaceOrder(workspaceOrder);
    try {
      window.localStorage.setItem(
        "walle.sidebar-workspace-order",
        JSON.stringify(workspaceOrder),
      );
    } catch {
      /* Storage may be unavailable. Keep the order for this window. */
    }
  }, [workspaceOrder, savedWorkspaceOrder]);

  const unreadIds = useMemo(() => new Set(unreadThreadIds), [unreadThreadIds]);

  const visibleThreads = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return threads
      .filter((thread) => thread.archived === showArchived)
      .filter(
        (thread) =>
          !needle ||
          thread.title.toLocaleLowerCase().includes(needle) ||
          thread.workspaceName.toLocaleLowerCase().includes(needle) ||
          thread.lastMessage?.toLocaleLowerCase().includes(needle),
      )
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
      );
  }, [query, showArchived, threads]);

  const pinned = visibleThreads.filter((thread) => thread.pinned);
  const groups = useMemo(() => {
    const result = new Map<
      string,
      {
        workspaceName: string;
        threads: ThreadRecord[];
        unreadCount: number;
      }
    >();
    for (const thread of visibleThreads) {
      const current = result.get(thread.workspaceRoot) ?? {
        workspaceName: thread.workspaceName,
        threads: [],
        unreadCount: 0,
      };
      if (unreadIds.has(thread.id) && !activeIds.includes(thread.id)) {
        current.unreadCount += 1;
      }
      if (!thread.pinned) current.threads.push(thread);
      result.set(thread.workspaceRoot, current);
    }
    if (
      draftWorkspaceRoot &&
      !result.has(draftWorkspaceRoot) &&
      !showArchived &&
      !query.trim()
    ) {
      result.set(draftWorkspaceRoot, {
        workspaceName:
          draftWorkspaceRoot.split(/[\\/]/).filter(Boolean).at(-1) ??
          draftWorkspaceRoot,
        threads: [],
        unreadCount: 0,
      });
    }
    return [...result.entries()].sort(
      ([a], [b]) => workspaceOrder.indexOf(a) - workspaceOrder.indexOf(b),
    );
  }, [
    activeIds,
    draftWorkspaceRoot,
    query,
    showArchived,
    unreadIds,
    visibleThreads,
    workspaceOrder,
  ]);

  const selectThread = (id: string) => {
    onSelect(id);
    onMobileClose();
  };

  const toggleWorkspace = (workspaceRoot: string) => {
    setCollapsedWorkspaces((current) => {
      const next = new Set(current);
      if (next.has(workspaceRoot)) next.delete(workspaceRoot);
      else next.add(workspaceRoot);
      return next;
    });
  };

  const openRename = (thread: ThreadRecord) => {
    setRenameThread(thread);
    setRenameValue(thread.title);
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setQuery("");
  };

  const toggleSearch = () => {
    if (searchOpen) closeSearch();
    else setSearchOpen(true);
  };

  const submitRename = async () => {
    if (!renameThread || !renameValue.trim()) return;
    if (await onUpdate(renameThread.id, { title: renameValue.trim() })) {
      setRenameThread(null);
    }
  };

  return (
    <>
      {mobileOpen && (
        <button
          aria-label="Close sidebar"
          className="fixed inset-0 z-30 bg-black/20 backdrop-blur-[1px] min-[861px]:hidden"
          onClick={onMobileClose}
        />
      )}
      <aside
        className={cn(
          "walle-divider-right fixed bottom-0 left-0 top-12 z-40 w-[276px] shrink-0 overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width,transform,border-color,box-shadow] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none min-[861px]:static min-[861px]:z-auto min-[861px]:translate-x-0",
          !visible &&
            "min-[861px]:pointer-events-none min-[861px]:w-0 min-[861px]:border-r-transparent min-[861px]:shadow-none",
          mobileOpen ? "translate-x-0 shadow-xl" : "-translate-x-full",
        )}
        aria-label="Conversation sidebar"
        aria-hidden={!visible}
        data-state={visible ? "open" : "closed"}
      >
        <div
          className={cn(
            "relative flex h-full w-[276px] shrink-0 flex-col transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none",
            visible
              ? "translate-x-0 opacity-100 delay-75"
              : "-translate-x-2 opacity-0 delay-0",
          )}
          data-slot="sidebar-content"
        >
          <div className="flex h-11 shrink-0 items-center gap-1 px-2.5">
            {searchOpen ? (
              <div
                role="search"
                data-slot="sidebar-search"
                className="min-w-0 flex-1"
              >
                <div className="relative">
                  <IconSearch className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    autoFocus
                    value={query}
                    onChange={(event) => setQuery(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        closeSearch();
                      }
                    }}
                    placeholder="Search conversations"
                    className="h-8 rounded-md border-sidebar-border/80 bg-background/90 pl-7 text-xs shadow-none"
                  />
                </div>
              </div>
            ) : (
              <div
                className="flex h-8 min-w-0 flex-1 items-center gap-2 px-2 text-sm font-semibold"
                data-slot="sidebar-brand"
              >
                <span className="flex size-5 items-center justify-center rounded-[6px] bg-[var(--brand-soft)] text-[var(--brand)]">
                  <IconSparkles className="size-3.5" />
                </span>
                Walle
              </div>
            )}

            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Search conversations"
                    aria-expanded={searchOpen}
                    onClick={toggleSearch}
                  />
                }
              >
                {searchOpen ? <IconX /> : <IconSearch />}
              </TooltipTrigger>
              <TooltipContent>Search</TooltipContent>
            </Tooltip>
            <Button
              className="min-[861px]:hidden"
              variant="ghost"
              size="icon-sm"
              aria-label="Close sidebar"
              onClick={onMobileClose}
            >
              <IconX />
            </Button>
          </div>

          <nav
            className="shrink-0 space-y-0.5 px-2.5 pb-2"
            aria-label="Walle navigation"
          >
            <button
              type="button"
              className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-xs hover:bg-sidebar-accent/65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/50 disabled:opacity-50"
              onClick={() => void onCreate()}
              disabled={creating}
            >
              <IconMessagePlus className="size-4 text-muted-foreground" />
              New thread
              {creating && (
                <span className="ml-auto size-3 animate-spin rounded-full border border-current border-t-transparent" />
              )}
            </button>
            <button
              type="button"
              className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-xs hover:bg-sidebar-accent/65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/50"
              onClick={onOpenEvolution}
            >
              <IconBolt className="size-4 text-muted-foreground" />
              Evolution inbox
              {evolutionCount > 0 && (
                <span className="ml-auto flex min-w-4 items-center justify-center rounded-full bg-[var(--brand-soft)] px-1 text-[10px] font-medium text-[var(--brand)]">
                  {evolutionCount}
                </span>
              )}
            </button>
            <button
              type="button"
              className={cn(
                "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-xs hover:bg-sidebar-accent/65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/50",
                showArchived && "bg-sidebar-accent",
              )}
              onClick={() => setShowArchived((value) => !value)}
            >
              <IconArchive className="size-4 text-muted-foreground" />
              {showArchived ? "Back to threads" : "Archived"}
              {!showArchived && threads.some((thread) => thread.archived) && (
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {threads.filter((thread) => thread.archived).length}
                </span>
              )}
            </button>
          </nav>

          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-4 px-2.5 pb-5 pt-1">
              {pinned.length > 0 && (
                <section>
                  <div className="mb-1 flex h-6 items-center px-2 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/75">
                    Pinned
                  </div>
                  <div className="space-y-0.5">
                    {pinned.map((thread) => (
                      <ThreadRow
                        key={thread.id}
                        thread={thread}
                        active={activeIds.includes(thread.id)}
                        unread={
                          unreadIds.has(thread.id) &&
                          !activeIds.includes(thread.id)
                        }
                        onSelect={() => selectThread(thread.id)}
                        onRename={() => openRename(thread)}
                        onUpdate={onUpdate}
                        onDelete={() => setDeleteThread(thread)}
                      />
                    ))}
                  </div>
                </section>
              )}

              {groups.map(([workspaceRoot, group]) => {
                const expanded = !collapsedWorkspaces.has(workspaceRoot);
                const groupLabel = `${group.workspaceName} workspace`;

                return (
                  <section key={workspaceRoot}>
                    <div
                      className="group/workspace mb-1 flex h-7 min-w-0 items-center rounded-lg px-1 text-[11px] font-medium text-muted-foreground hover:bg-sidebar-accent/55 focus-within:bg-sidebar-accent/55"
                      title={workspaceRoot}
                    >
                      <button
                        type="button"
                        className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/50"
                        aria-label={`${expanded ? "Collapse" : "Expand"} ${groupLabel}${!expanded && group.unreadCount > 0 ? `, ${group.unreadCount} unread` : ""}`}
                        aria-expanded={expanded}
                        onClick={() => toggleWorkspace(workspaceRoot)}
                      >
                        {expanded ? (
                          <IconFolderOpen className="size-3.5 shrink-0" />
                        ) : (
                          <IconFolder className="size-3.5 shrink-0" />
                        )}
                        <span className="truncate">{group.workspaceName}</span>
                        {!expanded && group.unreadCount > 0 && (
                          <>
                            <span
                              aria-hidden="true"
                              data-slot="workspace-unread-dot"
                              className="ml-auto size-1.5 shrink-0 rounded-full bg-[var(--info)]"
                            />
                            <span className="sr-only">
                              {group.unreadCount} unread
                            </span>
                          </>
                        )}
                      </button>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              className="pointer-events-none size-6 opacity-0 transition-opacity group-hover/workspace:pointer-events-auto group-hover/workspace:opacity-100 group-focus-within/workspace:pointer-events-auto group-focus-within/workspace:opacity-100"
                              aria-label={`New task in ${group.workspaceName}`}
                              disabled={creating}
                              onClick={(event) => {
                                event.stopPropagation();
                                void onCreateInWorkspace(workspaceRoot);
                              }}
                            />
                          }
                        >
                          <IconSquareRoundedPlus className="size-4" />
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          New task in {group.workspaceName}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                    {expanded && (
                      <div className="space-y-0.5">
                        {group.threads.map((thread) => (
                          <ThreadRow
                            key={thread.id}
                            thread={thread}
                            active={activeIds.includes(thread.id)}
                            unread={
                              unreadIds.has(thread.id) &&
                              !activeIds.includes(thread.id)
                            }
                            onSelect={() => selectThread(thread.id)}
                            onRename={() => openRename(thread)}
                            onUpdate={onUpdate}
                            onDelete={() => setDeleteThread(thread)}
                          />
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}

              {visibleThreads.length === 0 && (
                <div className="px-5 py-8 text-center text-xs text-muted-foreground">
                  {query
                    ? "No matching conversations"
                    : showArchived
                      ? "No archived conversations"
                      : "No conversations yet"}
                </div>
              )}
            </div>
          </ScrollArea>

          <div className="flex h-12 shrink-0 items-center gap-2 border-t border-sidebar-border px-3">
            <span className="flex size-6 items-center justify-center rounded-full bg-[var(--brand-soft)] text-[10px] font-semibold text-[var(--brand)]">
              W
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11px] font-medium">
                Local workspace
              </div>
              <div className="truncate text-[9px] text-muted-foreground">
                Stored locally · model context goes to your provider
              </div>
            </div>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="hover:bg-sidebar-accent/85 hover:text-sidebar-accent-foreground dark:hover:bg-sidebar-accent/85"
                    aria-label="Open settings"
                    onClick={onOpenSettings}
                  />
                }
              >
                <IconSettings />
              </TooltipTrigger>
              <TooltipContent>Settings</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </aside>

      <Dialog
        open={Boolean(renameThread)}
        onOpenChange={(open) => !open && setRenameThread(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename thread</DialogTitle>
            <DialogDescription>
              Choose a short name that is easy to scan in the sidebar.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={renameValue}
            onChange={(event) => setRenameValue(event.currentTarget.value)}
            onKeyDown={(event) => event.key === "Enter" && void submitRename()}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameThread(null)}>
              Cancel
            </Button>
            <Button
              disabled={!renameValue.trim()}
              onClick={() => void submitRename()}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(deleteThread)}
        onOpenChange={(open) => !open && setDeleteThread(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteThread?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the conversation history from this Mac. Files in the
              workspace are not changed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleteThread) void onDelete(deleteThread.id);
                setDeleteThread(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
