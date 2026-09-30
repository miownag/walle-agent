import {
  IconAlertCircle,
  IconBrain,
  IconCheck,
  IconChevronDown,
  IconCode,
  IconFilePencil,
  IconFileText,
  IconFolder,
  IconLoader2,
  IconRobot,
  IconSearch,
  IconShieldCheck,
  IconShieldExclamation,
  IconTerminal2,
  IconUsers,
  IconWorld,
  IconX,
} from "@tabler/icons-react";
import {
  useState,
  type ComponentType,
  type ReactNode,
  type SVGProps,
} from "react";

import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { formatBytes, formatDuration, safeJson } from "@/lib/format";
import { processIsOpen, stepTypeLabel } from "@/state/agent-stream";
import type { AssistantTimelineItem, ProcessStep } from "@shared/contracts";
import { CopyButton } from "./copy-button";
import { Markdown } from "./markdown";

interface AssistantTurnProps {
  item: AssistantTimelineItem;
  onDisclosureChange: (
    runId: string,
    disclosure: "expanded" | "collapsed",
  ) => void;
  onResolveApproval: (
    approvalId: string,
    decision: "allow-once" | "always-allow" | "deny",
  ) => Promise<void>;
  onOpenExternal: (url: string) => void;
}

type TablerIcon = ComponentType<SVGProps<SVGSVGElement>>;

const stepIcons: Record<ProcessStep["type"], TablerIcon> = {
  reasoning: IconBrain,
  tool: IconTerminal2,
  approval: IconShieldExclamation,
  status: IconCode,
  subagent: IconUsers,
};

function statusIcon(step: ProcessStep) {
  if (step.status === "running" || step.status === "pending") {
    return (
      <IconLoader2 className="size-3.5 animate-spin text-muted-foreground" />
    );
  }
  if (step.status === "error")
    return <IconAlertCircle className="size-3.5 text-destructive" />;
  if (step.status === "denied" || step.status === "cancelled") {
    return <IconX className="size-3.5 text-muted-foreground" />;
  }
  return <IconCheck className="size-3.5 text-[var(--success)]" />;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  return value as Record<string, unknown>;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function compactText(value: unknown): string | undefined {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return;
}

interface ToolSummary {
  promotedKeys: string[];
  text?: string;
}

const SAFE_SUMMARY_KEYS = [
  "path",
  "file",
  "url",
  "query",
  "pattern",
  "command",
  "cwd",
  "name",
  "description",
  "id",
] as const;

function toolSummary(step: ProcessStep): ToolSummary {
  const input = step.input ?? {};
  const name = step.toolName ?? step.title;
  const path = compactText(input.path);
  const file = compactText(input.file);
  const pattern = compactText(input.pattern);
  const command = compactText(input.command);

  if (["read_file", "write_file", "edit_file"].includes(name)) {
    const start = numberValue(input.startLine);
    const end = numberValue(input.endLine);
    const range = start !== undefined ? `:${start}${end ? `–${end}` : ""}` : "";
    return {
      text: path ? `${path}${range}` : undefined,
      promotedKeys: ["path"],
    };
  }
  if (["ls", "list_files"].includes(name)) {
    return {
      text:
        path ??
        compactText(input.dir) ??
        compactText(input.directory) ??
        compactText(input.cwd) ??
        ".",
      promotedKeys: ["path", "dir", "directory", "cwd"],
    };
  }
  if (name === "glob") {
    return {
      text: pattern,
      promotedKeys: ["pattern"],
    };
  }
  if (name === "grep") {
    return {
      text: pattern ? `“${pattern}”${file ? ` in ${file}` : ""}` : file,
      promotedKeys: ["pattern", "file"],
    };
  }
  if (name === "shell" || name === "bash") {
    return { text: command, promotedKeys: ["command"] };
  }
  if (name === "web_fetch") {
    return { text: compactText(input.url), promotedKeys: ["url"] };
  }
  if (name === "task") {
    return {
      text: compactText(input.description) ?? compactText(input.subagent_type),
      promotedKeys: ["description", "subagent_type"],
    };
  }

  for (const key of SAFE_SUMMARY_KEYS) {
    const value = compactText(input[key]);
    if (value) return { text: value, promotedKeys: [key] };
  }
  return { promotedKeys: [] };
}

function toolIcon(step: ProcessStep): TablerIcon {
  const name = step.toolName ?? step.title;
  if (name === "read_file") return IconFileText;
  if (name === "write_file" || name === "edit_file") return IconFilePencil;
  if (name === "ls" || name === "list_files" || name === "glob")
    return IconFolder;
  if (name === "grep" || name === "tool_search") return IconSearch;
  if (name === "web_fetch") return IconWorld;
  return IconTerminal2;
}

function DetailBlock({
  caption,
  children,
  label,
  tone = "default",
}: {
  caption?: string;
  children: ReactNode;
  label: string;
  tone?: "default" | "error";
}) {
  return (
    <section className="min-w-0">
      <div className="mb-1 flex min-h-4 items-center gap-2 px-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">
        <span>{label}</span>
        {caption && (
          <span className="min-w-0 truncate font-normal normal-case tracking-normal text-muted-foreground/60">
            {caption}
          </span>
        )}
      </div>
      <div
        className={cn(
          "max-h-72 overflow-auto rounded-md border border-border/45 bg-[var(--code-bg)] text-[11px] leading-[1.55] text-foreground/88",
          tone === "error" &&
            "border-destructive/20 bg-destructive/5 text-destructive",
        )}
        tabIndex={0}
      >
        {children}
      </div>
    </section>
  );
}

function TextDetail({
  caption,
  content,
  label,
  tone,
}: {
  caption?: string;
  content: string;
  label: string;
  tone?: "default" | "error";
}) {
  return (
    <DetailBlock label={label} caption={caption} tone={tone}>
      <pre className="m-0 min-w-max whitespace-pre-wrap break-words p-2.5 font-mono">
        {content || "(no output)"}
      </pre>
    </DetailBlock>
  );
}

function Metadata({
  items,
}: {
  items: Array<{ label: string; value: string | number | boolean | undefined }>;
}) {
  const visible = items.filter((item) => item.value !== undefined);
  if (visible.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 rounded-md bg-muted/35 px-2.5 py-1.5 text-[10px] text-muted-foreground">
      {visible.map((item) => (
        <span key={item.label}>
          <span className="text-muted-foreground/65">{item.label}</span>{" "}
          <span className="font-medium text-foreground/75">
            {String(item.value)}
          </span>
        </span>
      ))}
    </div>
  );
}

function genericValueDetail({
  label,
  value,
}: {
  label: string;
  value: unknown;
}): ReactNode {
  if (typeof value === "string")
    return <TextDetail label={label} content={value} />;
  if (
    Array.isArray(value) &&
    value.every((entry) =>
      ["string", "number", "boolean"].includes(typeof entry),
    )
  ) {
    return <TextDetail label={label} content={value.map(String).join("\n")} />;
  }

  const record = asRecord(value);
  if (record) {
    const error = textValue(record.error);
    if (error) return <TextDetail label="Error" content={error} tone="error" />;
    if (record.truncated === true && typeof record.preview === "string") {
      const total = numberValue(record.totalCharacters);
      return (
        <TextDetail
          label={label}
          caption={
            total
              ? `truncated from ${total.toLocaleString()} characters`
              : "truncated"
          }
          content={record.preview}
        />
      );
    }
    for (const key of ["content", "stdout", "result", "output", "text"]) {
      const content = textValue(record[key]);
      if (content) return <TextDetail label={label} content={content} />;
    }
  }

  return <TextDetail label={label} content={safeJson(value)} />;
}

function withoutKeys(
  input: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => !keys.includes(key)),
  );
}

function formatDirectoryEntries(
  output: Record<string, unknown>,
): string | undefined {
  const entries = Array.isArray(output.entries)
    ? output.entries
    : Array.isArray(output.recursiveEntries)
      ? output.recursiveEntries
      : undefined;
  if (!entries) return;
  return entries
    .map((entry) => {
      if (typeof entry === "string") return entry;
      const record = asRecord(entry);
      if (!record) return safeJson(entry);
      const name =
        textValue(record.name) ?? textValue(record.path) ?? "(unknown)";
      const suffix = record.type === "directory" ? "/" : "";
      const size = numberValue(record.size);
      return `${name}${suffix}${size !== undefined ? `  ${formatBytes(size)}` : ""}`;
    })
    .join("\n");
}

function formatGrepResults(
  output: Record<string, unknown>,
): string | undefined {
  if (!Array.isArray(output.results)) return;
  const lines: string[] = [];
  for (const rawResult of output.results) {
    const result = asRecord(rawResult);
    if (!result) continue;
    const file = textValue(result.file) ?? "";
    if (!Array.isArray(result.lines)) continue;
    for (const rawLine of result.lines) {
      const line = asRecord(rawLine);
      if (!line) continue;
      const lineNumber = numberValue(line.lineNumber);
      const content = compactText(line.content) ?? "";
      lines.push(
        `${file}${lineNumber !== undefined ? `:${lineNumber}` : ""}  ${content}`,
      );
    }
  }
  return lines.join("\n");
}

function ToolDetails({
  promotedKeys,
  step,
}: {
  promotedKeys: string[];
  step: ProcessStep;
}) {
  const input = step.input ?? {};
  const output = asRecord(step.output);
  const name = step.toolName ?? step.title;
  const error = step.content ?? textValue(output?.error);
  const remainingInput = withoutKeys(input, promotedKeys);
  const hasRemainingInput = Object.keys(remainingInput).length > 0;

  if (name === "read_file") {
    const content = textValue(output?.content);
    const readLines = asRecord(output?.readLines);
    const start = numberValue(readLines?.start) ?? numberValue(input.startLine);
    const end = numberValue(readLines?.end) ?? numberValue(input.endLine);
    const total = numberValue(output?.totalLines);
    const caption =
      start !== undefined
        ? `lines ${start}${end !== undefined ? `–${end}` : ""}${total !== undefined ? ` of ${total}` : ""}`
        : total !== undefined
          ? `${total} lines`
          : undefined;
    return (
      <div className="space-y-2">
        {error && <TextDetail label="Error" content={error} tone="error" />}
        {content !== undefined && (
          <TextDetail
            label="File contents"
            caption={caption}
            content={content}
          />
        )}
        {!error &&
          content === undefined &&
          step.output !== undefined &&
          genericValueDetail({ label: "Output", value: step.output })}
      </div>
    );
  }

  if (name === "write_file" || name === "edit_file") {
    const bytes = numberValue(output?.bytesWritten);
    return (
      <div className="space-y-2">
        {textValue(input.content) !== undefined && (
          <TextDetail label="Content" content={String(input.content)} />
        )}
        {textValue(input.search) !== undefined && (
          <TextDetail label="Find" content={String(input.search)} />
        )}
        {textValue(input.replace) !== undefined && (
          <TextDetail label="Replace with" content={String(input.replace)} />
        )}
        {error && <TextDetail label="Error" content={error} tone="error" />}
        <Metadata
          items={[
            { label: "Status", value: compactText(output?.status) },
            {
              label: "Written",
              value: bytes === undefined ? undefined : formatBytes(bytes),
            },
            {
              label: "Replace all",
              value:
                typeof input.global === "boolean" ? input.global : undefined,
            },
          ]}
        />
        {!error &&
          !output &&
          step.output !== undefined &&
          genericValueDetail({ label: "Output", value: step.output })}
      </div>
    );
  }

  if (name === "ls" || name === "list_files") {
    const entries = output ? formatDirectoryEntries(output) : undefined;
    const count =
      numberValue(output?.entries) ??
      (Array.isArray(output?.entries) ? output.entries.length : undefined) ??
      (Array.isArray(output?.recursiveEntries)
        ? output.recursiveEntries.length
        : undefined);
    return (
      <div className="space-y-2">
        <Metadata
          items={[
            { label: "Entries", value: count },
            {
              label: "Recursive",
              value:
                typeof input.recursive === "boolean"
                  ? input.recursive
                  : undefined,
            },
          ]}
        />
        {error && <TextDetail label="Error" content={error} tone="error" />}
        {entries !== undefined && (
          <TextDetail label="Directory contents" content={entries} />
        )}
        {!error &&
          entries === undefined &&
          step.output !== undefined &&
          genericValueDetail({ label: "Output", value: step.output })}
      </div>
    );
  }

  if (name === "glob") {
    const matches = Array.isArray(output?.matches)
      ? output.matches.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : undefined;
    return (
      <div className="space-y-2">
        <Metadata
          items={[
            {
              label: "Matches",
              value: numberValue(output?.count) ?? matches?.length,
            },
          ]}
        />
        {error && <TextDetail label="Error" content={error} tone="error" />}
        {matches && (
          <TextDetail label="Matching files" content={matches.join("\n")} />
        )}
        {!error &&
          !matches &&
          step.output !== undefined &&
          genericValueDetail({ label: "Output", value: step.output })}
      </div>
    );
  }

  if (name === "grep") {
    const results = output ? formatGrepResults(output) : undefined;
    return (
      <div className="space-y-2">
        <Metadata
          items={[
            {
              label: "Files searched",
              value: numberValue(output?.filesSearched),
            },
            {
              label: "Files matched",
              value: numberValue(output?.filesMatched),
            },
          ]}
        />
        {error && <TextDetail label="Error" content={error} tone="error" />}
        {results !== undefined && (
          <TextDetail label="Matches" content={results} />
        )}
        {!error &&
          results === undefined &&
          step.output !== undefined &&
          genericValueDetail({ label: "Output", value: step.output })}
      </div>
    );
  }

  if (name === "shell" || name === "bash") {
    const stdout = textValue(output?.stdout) ?? textValue(output?.output);
    const stderr = textValue(output?.stderr);
    return (
      <div className="space-y-2">
        <Metadata
          items={[
            { label: "cwd", value: compactText(input.cwd) },
            { label: "Exit", value: numberValue(output?.exitCode) },
            {
              label: "Duration",
              value:
                numberValue(output?.durationMs) !== undefined
                  ? formatDuration(numberValue(output?.durationMs))
                  : undefined,
            },
            {
              label: "Timed out",
              value: output?.timedOut === true ? true : undefined,
            },
          ]}
        />
        {error && <TextDetail label="Error" content={error} tone="error" />}
        {stdout !== undefined && <TextDetail label="Output" content={stdout} />}
        {stderr !== undefined && (
          <TextDetail label="Standard error" content={stderr} tone="error" />
        )}
        {!error &&
          stdout === undefined &&
          stderr === undefined &&
          step.output !== undefined &&
          genericValueDetail({ label: "Output", value: step.output })}
      </div>
    );
  }

  if (name === "web_fetch") {
    const response = textValue(output?.content) ?? textValue(output?.message);
    return (
      <div className="space-y-2">
        {textValue(input.prompt) && (
          <TextDetail label="Request" content={String(input.prompt)} />
        )}
        <Metadata
          items={[
            { label: "HTTP", value: numberValue(output?.status) },
            { label: "Type", value: compactText(output?.contentType) },
            {
              label: "Cached",
              value: output?.cached === true ? true : undefined,
            },
            {
              label: "Truncated",
              value: output?.truncated === true ? true : undefined,
            },
          ]}
        />
        {error && <TextDetail label="Error" content={error} tone="error" />}
        {response !== undefined && (
          <TextDetail label="Response" content={response} />
        )}
        {!error &&
          response === undefined &&
          step.output !== undefined &&
          genericValueDetail({ label: "Output", value: step.output })}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {hasRemainingInput &&
        genericValueDetail({ label: "Input", value: remainingInput })}
      {error && <TextDetail label="Error" content={error} tone="error" />}
      {!error &&
        step.output !== undefined &&
        genericValueDetail({ label: "Output", value: step.output })}
    </div>
  );
}

function ToolStatusMeta({ step }: { step: ProcessStep }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1">
      <span aria-hidden="true">{statusIcon(step)}</span>
      <span className="sr-only">{step.status}</span>
      {step.durationMs !== undefined && (
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {formatDuration(step.durationMs)}
        </span>
      )}
    </span>
  );
}

function ToolStepRow({ step }: { step: ProcessStep }) {
  const [open, setOpen] = useState(false);
  const summary = toolSummary(step);
  const ToolIcon = toolIcon(step);
  const label = step.toolName ?? step.title;
  const hasDetails =
    Boolean(step.content) ||
    Boolean(step.input && Object.keys(step.input).length) ||
    step.output !== undefined;

  if (!hasDetails) {
    return (
      <div className="relative grid grid-cols-[18px_minmax(0,1fr)] gap-2 py-1.5">
        <div className="relative z-10 flex size-[18px] items-center justify-center rounded-full bg-background text-muted-foreground">
          <ToolIcon className="size-3.5" aria-hidden="true" />
        </div>
        <div className="flex min-h-[18px] min-w-0 items-center gap-1.5 text-xs">
          <span className="shrink-0 font-medium text-foreground/85">
            {label}
          </span>
          {summary.text && (
            <span
              className="min-w-0 truncate font-mono text-[11px] text-muted-foreground"
              title={summary.text}
            >
              {summary.text}
            </span>
          )}
          <ToolStatusMeta step={step} />
        </div>
      </div>
    );
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className="group/tool relative grid w-full cursor-pointer grid-cols-[18px_minmax(0,1fr)] gap-2 rounded-md py-1.5 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        aria-label={`${label}${summary.text ? ` ${summary.text}` : ""}, ${step.status}`}
      >
        <div className="relative z-10 flex size-[18px] items-center justify-center rounded-full bg-background text-muted-foreground">
          <ToolIcon className="size-3.5" aria-hidden="true" />
        </div>
        <div className="flex min-h-[18px] min-w-0 items-center gap-1.5 pr-1 text-xs">
          <span className="shrink-0 font-medium text-foreground/85">
            {label}
          </span>
          {summary.text && (
            <span
              className="min-w-0 truncate font-mono text-[11px] text-muted-foreground"
              title={summary.text}
            >
              {summary.text}
            </span>
          )}
          <ToolStatusMeta step={step} />
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-open:animate-in data-closed:animate-out data-open:fade-in data-closed:fade-out">
        <div className="ml-[26px] pb-2 pr-1 pt-1">
          <ToolDetails step={step} promotedKeys={summary.promotedKeys} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ApprovalStep({
  step,
  onResolve,
}: {
  step: ProcessStep;
  onResolve: AssistantTurnProps["onResolveApproval"];
}) {
  const pending = step.status === "pending" && Boolean(step.approvalId);
  const approvalTags =
    (step as ProcessStep & { approvalTags?: string[] }).approvalTags ?? [];
  const canAlwaysAllow =
    step.riskLevel === "low" &&
    !approvalTags.some((tag) =>
      ["file-write", "shell", "network", "mcp"].includes(tag),
    );
  const riskTone =
    step.riskLevel === "high"
      ? "text-destructive bg-destructive/8 border-destructive/20"
      : step.riskLevel === "medium"
        ? "text-[var(--warning)] bg-[var(--warning-soft)] border-[var(--warning)]/20"
        : "text-[var(--info)] bg-[var(--info-soft)] border-[var(--info)]/20";

  return (
    <div className={cn("mt-2 rounded-lg border px-3 py-2.5", riskTone)}>
      <div className="flex items-start gap-2">
        <IconShieldExclamation className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-foreground">{step.title}</span>
            <span className="rounded-full border border-current/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
              {step.riskLevel ?? "low"} risk
            </span>
          </div>
          {step.content && (
            <p className="mt-1 text-xs text-muted-foreground">{step.content}</p>
          )}
          {step.input && Object.keys(step.input).length > 0 && (
            <pre className="mt-2 max-h-36 overflow-auto rounded-md border border-border/70 bg-background/70 p-2 text-[11px] leading-4 text-foreground">
              {safeJson(step.input)}
            </pre>
          )}
        </div>
      </div>
      {pending ? (
        <div className="mt-2.5 flex flex-wrap justify-end gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void onResolve(step.approvalId!, "deny")}
          >
            Deny
          </Button>
          {canAlwaysAllow && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void onResolve(step.approvalId!, "always-allow")}
            >
              Always allow
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => void onResolve(step.approvalId!, "allow-once")}
          >
            Allow once
          </Button>
        </div>
      ) : (
        <div className="mt-2 flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
          {step.status === "denied" ? (
            <IconX className="size-3" />
          ) : (
            <IconShieldCheck className="size-3" />
          )}
          {step.status === "denied" ? "Denied" : "Resolved"}
        </div>
      )}
    </div>
  );
}

function ProcessStepRow({
  step,
  onResolve,
}: {
  step: ProcessStep;
  onResolve: AssistantTurnProps["onResolveApproval"];
}) {
  const StepIcon = stepIcons[step.type];
  const reasoning = step.type === "reasoning";
  if (step.type === "approval")
    return <ApprovalStep step={step} onResolve={onResolve} />;
  if (step.type === "tool") return <ToolStepRow step={step} />;

  return (
    <div className="group/step relative grid grid-cols-[18px_minmax(0,1fr)] gap-2 py-1.5">
      <div className="relative z-10 flex size-[18px] items-center justify-center rounded-full bg-background text-muted-foreground">
        <StepIcon className="size-3.5" />
      </div>
      <div className="min-w-0">
        <div className="flex min-h-[18px] min-w-0 items-center gap-1.5 text-xs">
          <span className="min-w-0 truncate font-medium text-foreground/85">
            {reasoning ? "Thinking" : step.title}
          </span>
          {!reasoning && (
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {stepTypeLabel(step.type)}
            </span>
          )}
          {!reasoning && (
            <span className="ml-auto shrink-0">{statusIcon(step)}</span>
          )}
          {!reasoning && step.durationMs !== undefined && (
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {formatDuration(step.durationMs)}
            </span>
          )}
        </div>
        {step.type === "reasoning" && step.content && (
          <Markdown
            className="mt-1 text-muted-foreground [&_p]:my-0"
            onOpenExternal={() => undefined}
          >
            {step.content}
          </Markdown>
        )}
        {step.type !== "reasoning" && step.content && (
          <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
            {step.content}
          </p>
        )}
      </div>
    </div>
  );
}

function processLabel(item: AssistantTimelineItem): string {
  if (item.status === "running") return "Working…";
  if (item.status === "cancelled") return "Run stopped";
  if (item.status === "error") return "Run failed";
  const started = new Date(item.createdAt).getTime();
  const completed = item.completedAt
    ? new Date(item.completedAt).getTime()
    : Number.NaN;
  const duration = Number.isFinite(completed - started)
    ? completed - started
    : undefined;
  return duration ? `Worked for ${formatDuration(duration)}` : "Work completed";
}

export function AssistantTurn({
  item,
  onDisclosureChange,
  onResolveApproval,
  onOpenExternal,
}: AssistantTurnProps) {
  const open = processIsOpen(item);
  const hasProcess =
    item.steps.length > 0 || item.status === "running" || Boolean(item.error);

  return (
    <article
      className="group/response relative w-full"
      aria-label="Walle response"
    >
      {hasProcess && (
        <Collapsible
          open={open}
          onOpenChange={(nextOpen) =>
            onDisclosureChange(item.runId, nextOpen ? "expanded" : "collapsed")
          }
        >
          <CollapsibleTrigger className="group/process flex min-h-7 w-full items-center gap-1.5 rounded-md px-1 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/45 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
            {item.status === "running" ? (
              <IconLoader2 className="size-3.5 animate-spin" />
            ) : item.status === "error" ? (
              <IconAlertCircle className="size-3.5 text-destructive" />
            ) : (
              <IconRobot className="size-3.5" />
            )}
            <span className="inline-flex items-center leading-none">
              {processLabel(item)}
            </span>
            {item.steps.length > 0 && (
              <span className="inline-flex items-center self-center text-[10px] leading-none text-muted-foreground/70">
                · {item.steps.length} steps
              </span>
            )}
            <IconChevronDown
              className={cn(
                "ml-auto size-3.5 shrink-0 -rotate-90 transition-transform",
                open && "rotate-0",
              )}
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="overflow-hidden data-open:animate-in data-closed:animate-out data-open:fade-in data-closed:fade-out">
            <div className="relative ml-2.5 border-l border-border/70 py-1 pl-3">
              {item.steps.map((step) => (
                <ProcessStepRow
                  key={step.id}
                  step={step}
                  onResolve={onResolveApproval}
                />
              ))}
              {item.steps.length === 0 && item.status === "running" && (
                <p className="py-2 text-xs text-muted-foreground">
                  Preparing the workspace…
                </p>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {item.error && (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/6 px-3 py-2.5 text-sm text-destructive">
          <IconAlertCircle className="mt-0.5 size-4 shrink-0" />
          <div>
            <div className="font-medium">Walle couldn’t finish this run</div>
            <div className="mt-0.5 text-xs opacity-85">{item.error}</div>
          </div>
        </div>
      )}

      {item.finalAnswer && (
        <>
          <Markdown
            className="mt-3 text-foreground"
            onOpenExternal={onOpenExternal}
          >
            {item.finalAnswer}
          </Markdown>
          <CopyButton
            className="absolute -bottom-6 left-0 opacity-0 group-hover/response:opacity-100 focus-visible:opacity-100"
            label="Copy final response"
            text={item.finalAnswer}
          />
        </>
      )}

      {!item.finalAnswer && item.draftAnswer && (
        <div className="mt-3">
          <Markdown onOpenExternal={onOpenExternal}>
            {item.draftAnswer}
          </Markdown>
          {item.status === "running" && (
            <span className="streaming-caret ml-0.5 inline-block h-4 w-0.5 bg-foreground/55 align-middle" />
          )}
        </div>
      )}
    </article>
  );
}
