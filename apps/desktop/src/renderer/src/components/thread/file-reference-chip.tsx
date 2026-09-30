import { IconFile } from "@tabler/icons-react";

import { cn } from "@/lib/utils";

export interface FileReferenceChipProps {
  name: string;
  relativePath: string;
  className?: string;
}

function readableFileLabel(name: string, relativePath: string): string {
  return (
    relativePath
      .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim() ||
    name
      .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim() ||
    "Referenced file"
  );
}

export function FileReferenceChip({
  name,
  relativePath,
  className,
}: FileReferenceChipProps) {
  const label = readableFileLabel(name, relativePath);

  return (
    <span
      data-file-reference-chip=""
      data-relative-path={relativePath}
      aria-label={`Referenced file ${label}`}
      title={label}
      className={cn(
        "mx-0.5 inline-flex max-w-[min(360px,80%)] items-center gap-1 rounded-md border border-border/75 bg-muted/75 px-1.5 py-0.5 align-baseline text-[11px] font-medium leading-4 text-foreground shadow-[0_1px_1px_rgba(0,0,0,0.035)]",
        className,
      )}
    >
      <IconFile className="size-3 shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
    </span>
  );
}
