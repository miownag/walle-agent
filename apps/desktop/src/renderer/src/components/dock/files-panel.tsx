import { useEffect, useRef, useState } from "react";
import {
  IconChevronRight,
  IconFile,
  IconFileCode,
  IconFolder,
  IconFolderOpen,
  IconLoader2,
  IconRefresh,
} from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/format";
import type { DesktopApi, FileEntry, FilePreview } from "@shared/contracts";
import { HighlightedCode } from "./highlighted-code";

interface FilesPanelProps {
  api: DesktopApi;
  workspaceRoot: string;
}

function fileIcon(entry: FileEntry) {
  if (entry.kind === "directory") return IconFolder;
  if (
    /\.(ts|tsx|js|jsx|json|css|html|md|py|rs|go|java|kt|swift|sh|yaml|yml)$/i.test(
      entry.name,
    )
  ) {
    return IconFileCode;
  }
  return IconFile;
}

export function FilesPanel({ api, workspaceRoot }: FilesPanelProps) {
  const [rootEntries, setRootEntries] = useState<FileEntry[]>([]);
  const [children, setChildren] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [selectedFilePath, setSelectedFilePath] = useState("");
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const workspaceGeneration = useRef(0);
  const rootRequestSequence = useRef(0);
  const childRequestSequences = useRef(new Map<string, number>());
  const previewRequestSequence = useRef(0);

  const loadRoot = async (generation = workspaceGeneration.current) => {
    const requestSequence = ++rootRequestSequence.current;
    setLoading(true);
    setError("");
    try {
      const entries = await api.readDirectory(workspaceRoot);
      if (
        generation !== workspaceGeneration.current ||
        requestSequence !== rootRequestSequence.current
      )
        return;
      setRootEntries(entries);
    } catch (cause) {
      if (
        generation !== workspaceGeneration.current ||
        requestSequence !== rootRequestSequence.current
      )
        return;
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not read this workspace.",
      );
    } finally {
      if (
        generation === workspaceGeneration.current &&
        requestSequence === rootRequestSequence.current
      )
        setLoading(false);
    }
  };

  useEffect(() => {
    const generation = ++workspaceGeneration.current;
    // Invalidate every request class before clearing the old workspace UI.
    rootRequestSequence.current++;
    childRequestSequences.current.clear();
    previewRequestSequence.current++;
    setChildren({});
    setExpanded(new Set());
    setLoadingPaths(new Set());
    setSelectedFilePath("");
    setPreview(null);
    setPreviewLoading(false);
    setPreviewError("");
    setError("");
    void loadRoot(generation);
    return () => {
      if (workspaceGeneration.current === generation)
        workspaceGeneration.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceRoot]);

  const toggleDirectory = async (entry: FileEntry) => {
    const nextExpanded = new Set(expanded);
    if (nextExpanded.has(entry.relativePath)) {
      nextExpanded.delete(entry.relativePath);
      setExpanded(nextExpanded);
      return;
    }
    nextExpanded.add(entry.relativePath);
    setExpanded(nextExpanded);
    if (children[entry.relativePath] || entry.children) return;
    const generation = workspaceGeneration.current;
    const requestSequence =
      (childRequestSequences.current.get(entry.relativePath) ?? 0) + 1;
    childRequestSequences.current.set(entry.relativePath, requestSequence);
    setLoadingPaths((current) => new Set(current).add(entry.relativePath));
    try {
      const result = await api.readDirectory(workspaceRoot, entry.relativePath);
      if (
        generation !== workspaceGeneration.current ||
        childRequestSequences.current.get(entry.relativePath) !==
          requestSequence
      )
        return;
      setChildren((current) => ({ ...current, [entry.relativePath]: result }));
    } catch (cause) {
      if (
        generation !== workspaceGeneration.current ||
        childRequestSequences.current.get(entry.relativePath) !==
          requestSequence
      )
        return;
      setError(
        cause instanceof Error
          ? cause.message
          : `Could not open ${entry.name}.`,
      );
    } finally {
      if (
        generation === workspaceGeneration.current &&
        childRequestSequences.current.get(entry.relativePath) ===
          requestSequence
      ) {
        setLoadingPaths((current) => {
          const next = new Set(current);
          next.delete(entry.relativePath);
          return next;
        });
      }
    }
  };

  const openFile = async (entry: FileEntry) => {
    const generation = workspaceGeneration.current;
    const requestSequence = ++previewRequestSequence.current;
    setSelectedFilePath(entry.relativePath);
    setPreview(null);
    setPreviewLoading(true);
    setPreviewError("");
    try {
      const nextPreview = await api.readFile(workspaceRoot, entry.relativePath);
      if (
        generation !== workspaceGeneration.current ||
        requestSequence !== previewRequestSequence.current
      )
        return;
      setPreview(nextPreview);
    } catch (cause) {
      if (
        generation !== workspaceGeneration.current ||
        requestSequence !== previewRequestSequence.current
      )
        return;
      setPreviewError(
        cause instanceof Error
          ? cause.message
          : `Could not read ${entry.name}.`,
      );
    } finally {
      if (
        generation === workspaceGeneration.current &&
        requestSequence === previewRequestSequence.current
      )
        setPreviewLoading(false);
    }
  };

  const renderEntries = (entries: FileEntry[], depth = 0) =>
    entries.map((entry) => {
      const isDirectory = entry.kind === "directory";
      const isExpanded = expanded.has(entry.relativePath);
      const EntryIcon =
        isDirectory && isExpanded ? IconFolderOpen : fileIcon(entry);
      const nested = entry.children ?? children[entry.relativePath] ?? [];
      return (
        <div key={entry.relativePath}>
          <button
            type="button"
            className={cn(
              "flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md pr-2 text-left text-[11px] hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
              selectedFilePath === entry.relativePath &&
                "bg-muted text-foreground",
            )}
            style={{ paddingLeft: `${8 + depth * 14}px` }}
            onClick={() =>
              void (isDirectory ? toggleDirectory(entry) : openFile(entry))
            }
          >
            {isDirectory ? (
              <IconChevronRight
                className={cn(
                  "size-3 shrink-0 text-muted-foreground transition-transform",
                  isExpanded && "rotate-90",
                  loadingPaths.has(entry.relativePath) && "animate-pulse",
                )}
              />
            ) : (
              <span className="w-3 shrink-0" />
            )}
            <EntryIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            {entry.size !== undefined && !isDirectory && (
              <span className="text-[9px] text-muted-foreground/70">
                {formatBytes(entry.size)}
              </span>
            )}
          </button>
          {isDirectory &&
            isExpanded &&
            nested.length > 0 &&
            renderEntries(nested, depth + 1)}
        </div>
      );
    });

  return (
    <ResizablePanelGroup orientation="vertical" className="min-h-0">
      <ResizablePanel id="file-tree" defaultSize="42%" minSize="20%">
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex h-8 shrink-0 items-center border-b px-2.5 text-[10px] font-medium uppercase tracking-[0.07em] text-muted-foreground">
            Explorer
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="ml-auto"
                    aria-label="Refresh files"
                    onClick={() => void loadRoot()}
                  />
                }
              >
                <IconRefresh />
              </TooltipTrigger>
              <TooltipContent>Refresh files</TooltipContent>
            </Tooltip>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-1.5 py-1.5">
            {loading ? (
              <div className="space-y-2 p-2">
                {Array.from({ length: 6 }).map((_, index) => (
                  <Skeleton
                    key={index}
                    className="h-4"
                    style={{ width: `${65 + (index % 3) * 10}%` }}
                  />
                ))}
              </div>
            ) : rootEntries.length ? (
              renderEntries(rootEntries)
            ) : (
              <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                {error || "This workspace is empty."}
              </div>
            )}
          </div>
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="file-preview" defaultSize="58%" minSize="24%">
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex h-8 shrink-0 items-center gap-2 border-b px-2.5 text-[10px] text-muted-foreground">
            {preview ? (
              <>
                <IconFileCode className="size-3.5" />
                <span
                  className="min-w-0 flex-1 truncate"
                  title={preview.relativePath}
                >
                  {preview.relativePath}
                </span>
                <span>{preview.language}</span>
              </>
            ) : selectedFilePath ? (
              <>
                {previewLoading ? (
                  <IconLoader2 className="size-3.5 animate-spin" />
                ) : (
                  <IconFile className="size-3.5" />
                )}
                <span
                  className="min-w-0 flex-1 truncate"
                  title={selectedFilePath}
                >
                  {selectedFilePath}
                </span>
              </>
            ) : (
              "Preview"
            )}
          </div>
          {previewLoading ? (
            <div className="min-h-0 flex-1 overflow-hidden bg-[var(--code-bg)] p-3">
              <div className="space-y-2.5" aria-label="Loading file preview">
                {Array.from({ length: 12 }).map((_, index) => (
                  <Skeleton
                    key={index}
                    className="h-3"
                    style={{ width: `${42 + ((index * 17) % 48)}%` }}
                  />
                ))}
              </div>
            </div>
          ) : preview ? (
            <div className="min-h-0 flex-1 overflow-auto bg-[var(--code-bg)]">
              <HighlightedCode
                content={preview.content}
                languageHint={preview.language}
                relativePath={preview.relativePath}
              />
              {preview.truncated && (
                <div className="sticky bottom-0 border-t bg-background/90 px-3 py-2 text-[10px] text-muted-foreground shadow-[0_-5px_14px_-12px_rgba(0,0,0,0.5)] backdrop-blur-sm">
                  Preview truncated · {formatBytes(preview.totalBytes)} total
                </div>
              )}
            </div>
          ) : previewError ? (
            <div className="flex min-h-0 flex-1 items-center justify-center bg-[var(--code-bg)] px-6 text-center">
              <div className="max-w-[260px]">
                <IconFile className="mx-auto mb-2 size-5 text-muted-foreground/70" />
                <div className="text-xs font-medium text-foreground/80">
                  Preview unavailable
                </div>
                <div className="mt-1 text-[10px] leading-4 text-muted-foreground">
                  {previewError}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
              Select a file to preview it here.
            </div>
          )}
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
