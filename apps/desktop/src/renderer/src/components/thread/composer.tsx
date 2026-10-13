import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import type { Editor } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { Placeholder } from "@tiptap/extensions/placeholder";
import { UndoRedo } from "@tiptap/extensions/undo-redo";
import { EditorContent, useEditor } from "@tiptap/react";
import {
  IconArrowUp,
  IconArrowsMinimize,
  IconAt,
  IconChevronDown,
  IconCheck,
  IconFile,
  IconFolder,
  IconLoader2,
  IconPaperclip,
  IconPhoto,
  IconPlayerStopFilled,
  IconShieldCheck,
  IconSlash,
  IconTrash,
  IconX,
} from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  type ContextCommand,
  type FollowUpMode,
  type PendingMessage,
  type ContextWindowSnapshot,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES,
  SUPPORTED_IMAGE_ATTACHMENT_MIME_TYPES,
  type ImageAttachmentInput,
  type PermissionMode,
  type ProviderProfile,
  type SavedImageAttachment,
  type SupportedImageAttachmentMimeType,
  type ThreadRecord,
  type UserMessagePart,
  type WorkspaceFileMatch,
} from "@shared/contracts";
import { providerModels } from "@shared/provider-models";
import { ContextWindowMeter } from "./context-window-meter";
import {
  extractEditorMessageParts,
  FileReferenceNode,
  insertFileReference,
  serializeEditorMessageParts,
  toUserMessageParts,
  trimEditorMessageParts,
} from "./file-reference-node";

interface PendingImageAttachment {
  id: string;
  file: File;
  previewUrl: string;
  saved?: SavedImageAttachment;
}

interface MentionQuery {
  query: string;
  start: number;
  end: number;
}

export interface ComposerProps {
  thread: ThreadRecord;
  providers: ProviderProfile[];
  permissionMode: PermissionMode;
  contextWindow?: ContextWindowSnapshot;
  maxContextTokens: number;
  running: boolean;
  followUpMode?: FollowUpMode;
  onFollowUpModeChange?: (mode: FollowUpMode) => Promise<void>;
  pendingMessages?: PendingMessage[];
  onPendingMessageAction?: (
    id: string,
    action: "remove" | "steer" | "send",
  ) => Promise<void>;
  focused: boolean;
  onSend: (
    prompt: string,
    displayPrompt?: string,
    imageAttachments?: SavedImageAttachment[],
    displayParts?: UserMessagePart[],
    mode?: FollowUpMode,
  ) => Promise<void>;
  onStop: () => Promise<void>;
  onSlashCommand: (command: ContextCommand) => Promise<void>;
  onProviderChange: (providerId: string, model?: string) => Promise<void>;
  onPermissionModeChange: (mode: PermissionMode) => Promise<void>;
  onSearchWorkspaceFiles?: (
    threadId: string,
    query: string,
  ) => Promise<WorkspaceFileMatch[]>;
  onSaveImageAttachments?: (
    threadId: string,
    attachments: ImageAttachmentInput[],
  ) => Promise<SavedImageAttachment[]>;
  onChangeWorkspace?: () => void;
}

const permissionLabels: Record<PermissionMode, string> = {
  auto: "Approve automatically",
  ask: "Ask before actions",
  "deny-high-risk": "Deny high-risk",
  "full-access": "Full Access",
};

const slashCommands: Array<{
  command: ContextCommand;
  label: string;
  description: string;
}> = [
  {
    command: "clear",
    label: "/clear",
    description: "Start this task with a fresh context",
  },
  {
    command: "compact",
    label: "/compact",
    description: "Summarize older turns and keep recent context",
  },
];

const composerTips = [
  "Use @ to reference workspace files",
  "Paste an image to add visual context",
  "Type / for context commands",
  "Shift + Enter adds a new line",
] as const;

function isSupportedImageType(
  value: string,
): value is SupportedImageAttachmentMimeType {
  return (SUPPORTED_IMAGE_ATTACHMENT_MIME_TYPES as readonly string[]).includes(
    value,
  );
}

function mentionAtSelection(editor: Editor): MentionQuery | null {
  const { selection } = editor.state;
  if (!selection.empty || !selection.$from.parent.isTextblock) return null;
  const beforeCursor = selection.$from.parent.textBetween(
    0,
    selection.$from.parentOffset,
    undefined,
    "\ufffc",
  );
  const match = /(^|[\s(])@([^\s@[\]]*)$/.exec(beforeCursor);
  if (!match) return null;
  const tokenLength = match[2].length + 1;
  return {
    query: match[2],
    start: selection.from - tokenLength,
    end: selection.from,
  };
}

function slashAtSelection(editor: Editor): string | null {
  const { selection, doc } = editor.state;
  if (!selection.empty || selection.from !== doc.content.size - 1) return null;
  const parts = trimEditorMessageParts(extractEditorMessageParts(editor));
  if (parts.some((part) => part.type === "file")) return null;
  const value = serializeEditorMessageParts(parts, "display");
  const match = /^\/([a-z-]*)$/i.exec(value);
  return match ? match[1].toLowerCase() : null;
}

function appendUserMessageText(
  parts: UserMessagePart[],
  text: string,
): UserMessagePart[] {
  if (!text) return parts;
  const next = parts.map((part) => ({ ...part }));
  const previous = next.at(-1);
  if (previous?.type === "text") previous.text += text;
  else next.push({ type: "text", text });
  return next;
}

function serializeUserMessageParts(parts: UserMessagePart[]): string {
  return parts
    .map((part) =>
      part.type === "text" ? part.text : `@[${part.relativePath}]`,
    )
    .join("");
}

function safeDisplayName(value: string): string {
  return (
    value
      .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 96) || "Pasted image"
  );
}

function fileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the pasted image"));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Could not encode the pasted image"));
        return;
      }
      const separator = reader.result.indexOf(",");
      if (separator < 0) {
        reject(new Error("Could not encode the pasted image"));
        return;
      }
      resolve(reader.result.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed.";
}

function workspaceSearchErrorText(error: unknown): string {
  const message = errorText(error);
  if (
    message.includes("No handler registered for") &&
    message.includes("workspace:search-files")
  ) {
    return "Walle's Electron main process is out of date. Restart desktop dev to use @ file search.";
  }
  return message;
}

export function Composer({
  thread,
  providers,
  permissionMode,
  contextWindow,
  maxContextTokens,
  running,
  followUpMode = "queue",
  onFollowUpModeChange,
  pendingMessages = [],
  onPendingMessageAction,
  focused,
  onSend,
  onStop,
  onSlashCommand,
  onProviderChange,
  onPermissionModeChange,
  onSearchWorkspaceFiles,
  onSaveImageAttachments,
  onChangeWorkspace,
}: ComposerProps) {
  const [draftText, setDraftText] = useState("");
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<PendingImageAttachment[]>([]);
  const [mentionQuery, setMentionQuery] = useState<MentionQuery | null>(null);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const [fileMatches, setFileMatches] = useState<WorkspaceFileMatch[]>([]);
  const [activeFileIndex, setActiveFileIndex] = useState(0);
  const [searchingFiles, setSearchingFiles] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [composerError, setComposerError] = useState("");
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const [tipIndex, setTipIndex] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentsRef = useRef(attachments);
  const submitRef = useRef<() => void>(() => undefined);
  const pasteRef = useRef<(event: ClipboardEvent) => boolean>(() => false);
  const keyDownRef = useRef<(event: KeyboardEvent) => boolean>(() => false);
  const editorUpdateRef = useRef<(editor: Editor) => void>(() => undefined);
  const placeholderRef = useRef(
    "Ask Walle… Use @ to reference a workspace file",
  );
  const searchSequence = useRef(0);
  const activeThreadId = useRef(thread.id);
  const previousThreadId = useRef(thread.id);
  const fileListId = useId();
  const slashListId = useId();
  const provider =
    providers.find((item) => item.id === thread.providerProfileId) ??
    providers[0];
  const currentModel = thread.model || provider?.model || "";
  const currentModelLabel =
    (provider &&
      providerModels(provider).find((entry) => entry.value === currentModel)
        ?.label) ||
    currentModel;
  const mentionOpen = Boolean(mentionQuery);
  const matchingSlashCommands =
    slashQuery === null
      ? []
      : slashCommands.filter(({ command }) => command.startsWith(slashQuery));
  const slashOpen = slashQuery !== null;
  const canSubmit = Boolean(draftText.trim() || attachments.length);

  const replaceAttachments = (next: PendingImageAttachment[]) => {
    attachmentsRef.current = next;
    setAttachments(next);
  };

  const revokeAttachments = (items: PendingImageAttachment[]) => {
    for (const attachment of items) URL.revokeObjectURL(attachment.previewUrl);
  };

  useEffect(
    () => () => {
      searchSequence.current += 1;
      revokeAttachments(attachmentsRef.current);
    },
    [],
  );

  useEffect(() => {
    const reducedMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    );
    if (reducedMotion?.matches) return;
    const timer = window.setInterval(
      () => setTipIndex((index) => (index + 1) % composerTips.length),
      4_000,
    );
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const sequence = ++searchSequence.current;
    setActiveFileIndex(0);
    setSearchError("");
    if (!mentionQuery) {
      setSearchingFiles(false);
      setFileMatches([]);
      return;
    }
    if (!onSearchWorkspaceFiles) {
      setSearchingFiles(false);
      setFileMatches([]);
      setSearchError("Workspace file search is unavailable.");
      return;
    }

    setSearchingFiles(true);
    const timer = window.setTimeout(() => {
      void onSearchWorkspaceFiles(thread.id, mentionQuery.query)
        .then((matches) => {
          if (searchSequence.current !== sequence) return;
          setFileMatches(matches);
          setSearchError("");
        })
        .catch((error: unknown) => {
          if (searchSequence.current !== sequence) return;
          setFileMatches([]);
          setSearchError(workspaceSearchErrorText(error));
        })
        .finally(() => {
          if (searchSequence.current === sequence) setSearchingFiles(false);
        });
    }, 100);

    return () => {
      window.clearTimeout(timer);
      if (searchSequence.current === sequence) searchSequence.current += 1;
    };
  }, [mentionQuery?.query, onSearchWorkspaceFiles, thread.id]);

  const updateCompletionQuery = (currentEditor: Editor) => {
    const nextSlash = slashAtSelection(currentEditor);
    if (nextSlash !== null) {
      setSlashQuery(nextSlash);
      setActiveSlashIndex(0);
      setMentionQuery(null);
      return;
    }
    setSlashQuery(null);
    setMentionQuery(mentionAtSelection(currentEditor));
  };

  const addImageFiles = (files: File[]) => {
    if (!files.length || sending) return;
    const next = [...attachmentsRef.current];
    let error = "";
    for (const file of files) {
      if (next.length >= MAX_IMAGE_ATTACHMENTS) {
        error = `You can attach up to ${MAX_IMAGE_ATTACHMENTS} images.`;
        break;
      }
      if (!isSupportedImageType(file.type)) {
        error = "Use a PNG, JPEG, WebP, or GIF image.";
        continue;
      }
      if (!file.size || file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
        error = `Each image must be smaller than ${MAX_IMAGE_ATTACHMENT_BYTES / (1024 * 1024)} MB.`;
        continue;
      }
      if (
        next.reduce((total, item) => total + item.file.size, 0) + file.size >
        MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES
      ) {
        error = `Images can use up to ${MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES / (1024 * 1024)} MB together.`;
        continue;
      }
      next.push({
        id: crypto.randomUUID(),
        file,
        previewUrl: URL.createObjectURL(file),
      });
    }
    replaceAttachments(next);
    setComposerError(error);
  };

  const handleEditorPaste = (event: ClipboardEvent): boolean => {
    const clipboard = event.clipboardData;
    if (!clipboard) return false;
    const imageItems = Array.from(clipboard.items).filter(
      (item) => item.kind === "file" && item.type.startsWith("image/"),
    );
    const files = imageItems
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (!files.length) return false;
    event.preventDefault();
    addImageFiles(files);
    return true;
  };
  pasteRef.current = handleEditorPaste;

  const editor = useEditor({
    extensions: [
      Document,
      Paragraph,
      Text,
      HardBreak,
      UndoRedo,
      FileReferenceNode,
      Placeholder.configure({ placeholder: () => placeholderRef.current }),
    ],
    content: { type: "doc", content: [{ type: "paragraph" }] },
    editable: !sending,
    editorProps: {
      attributes: {
        class:
          "walle-composer-editor max-h-48 min-h-[72px] overflow-y-auto px-3.5 py-3 text-[13px] leading-5 text-foreground outline-none",
        role: "textbox",
        "aria-label": "Message Walle",
        "aria-multiline": "true",
        "aria-haspopup": "listbox",
        spellcheck: "true",
      },
      handlePaste: (_view, event) => pasteRef.current(event),
      handleKeyDown: (_view, event) => keyDownRef.current(event),
    },
    onUpdate: ({ editor: currentEditor }) =>
      editorUpdateRef.current(currentEditor),
    onSelectionUpdate: ({ editor: currentEditor }) =>
      editorUpdateRef.current(currentEditor),
  });

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!sending);
    placeholderRef.current = running
      ? "Add a follow-up…"
      : "Ask Walle… Use @ to reference a workspace file";
    editor.view.dom.setAttribute("aria-disabled", sending ? "true" : "false");
    editor.view.dispatch(editor.state.tr);
  }, [editor, running, sending]);

  useEffect(() => {
    if (!editor) return;
    editor.view.dom.setAttribute(
      "aria-expanded",
      mentionOpen || slashOpen ? "true" : "false",
    );
    const controls = slashOpen
      ? slashListId
      : mentionOpen
        ? fileListId
        : undefined;
    const activeDescendant =
      slashOpen && matchingSlashCommands[activeSlashIndex]
        ? `${slashListId}-${activeSlashIndex}`
        : mentionOpen && fileMatches[activeFileIndex]
          ? `${fileListId}-${activeFileIndex}`
          : undefined;
    if (controls) editor.view.dom.setAttribute("aria-controls", controls);
    else editor.view.dom.removeAttribute("aria-controls");
    if (activeDescendant)
      editor.view.dom.setAttribute("aria-activedescendant", activeDescendant);
    else editor.view.dom.removeAttribute("aria-activedescendant");
  }, [
    activeFileIndex,
    activeSlashIndex,
    editor,
    fileListId,
    fileMatches,
    matchingSlashCommands,
    mentionOpen,
    slashListId,
    slashOpen,
  ]);

  useEffect(() => {
    activeThreadId.current = thread.id;
    if (previousThreadId.current === thread.id) return;
    previousThreadId.current = thread.id;
    searchSequence.current += 1;
    revokeAttachments(attachmentsRef.current);
    replaceAttachments([]);
    editor?.commands.clearContent(true);
    setDraftText("");
    setMentionQuery(null);
    setSlashQuery(null);
    setFileMatches([]);
    setPermissionMenuOpen(false);
    setComposerError("");
    setSending(false);
  }, [editor, thread.id]);

  useEffect(() => {
    if (focused && !sending) editor?.commands.focus("end");
  }, [editor, focused, running, sending, thread.id]);

  const onFilesSelected = (event: ChangeEvent<HTMLInputElement>) => {
    addImageFiles(Array.from(event.currentTarget.files ?? []));
    event.currentTarget.value = "";
  };

  const removeAttachment = (attachmentId: string) => {
    const attachment = attachmentsRef.current.find(
      (item) => item.id === attachmentId,
    );
    if (!attachment) return;
    URL.revokeObjectURL(attachment.previewUrl);
    replaceAttachments(
      attachmentsRef.current.filter((item) => item.id !== attachmentId),
    );
    setComposerError("");
  };

  const selectFile = (match: WorkspaceFileMatch) => {
    const query = mentionQuery;
    if (!query || !editor) return;
    insertFileReference(
      editor,
      { from: query.start, to: query.end },
      {
        name: match.name,
        relativePath: match.relativePath,
        absolutePath: match.path,
      },
    );
    setMentionQuery(null);
    setFileMatches([]);
  };

  const selectSlashCommand = (command: ContextCommand) => {
    if (!editor) return;
    const nextValue = `/${command}`;
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: nextValue }],
        },
      ],
    });
    setSlashQuery(null);
    setComposerError("");
    editor.commands.focus("end");
  };

  const executeSlashCommand = async (command: ContextCommand) => {
    if (running || sending) return;
    if (attachmentsRef.current.length) {
      setComposerError("Remove image attachments before running a command.");
      return;
    }
    const submissionThreadId = thread.id;
    setSending(true);
    setComposerError("");
    setMentionQuery(null);
    setSlashQuery(null);
    try {
      await onSlashCommand(command);
      if (activeThreadId.current !== submissionThreadId) return;
      editor?.commands.clearContent(true);
      setDraftText("");
    } catch (error) {
      if (activeThreadId.current === submissionThreadId) {
        setComposerError(errorText(error));
      }
    } finally {
      if (activeThreadId.current === submissionThreadId) setSending(false);
    }
  };

  const onComposerKeyDown = (event: KeyboardEvent): boolean => {
    if (event.key === "Enter" && (event.isComposing || event.keyCode === 229)) {
      return false;
    }
    if (slashOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveSlashIndex((index) =>
          matchingSlashCommands.length
            ? (index + 1) % matchingSlashCommands.length
            : 0,
        );
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveSlashIndex((index) =>
          matchingSlashCommands.length
            ? (index - 1 + matchingSlashCommands.length) %
              matchingSlashCommands.length
            : 0,
        );
        return true;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashQuery(null);
        return true;
      }
      if (event.key === "Enter" && matchingSlashCommands[activeSlashIndex]) {
        event.preventDefault();
        const selected = matchingSlashCommands[activeSlashIndex];
        if (draftText.trim() === selected.label) {
          void executeSlashCommand(selected.command);
        } else {
          selectSlashCommand(selected.command);
        }
        return true;
      }
    }
    if (mentionOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveFileIndex((index) =>
          fileMatches.length ? (index + 1) % fileMatches.length : 0,
        );
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveFileIndex((index) =>
          fileMatches.length
            ? (index - 1 + fileMatches.length) % fileMatches.length
            : 0,
        );
        return true;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        searchSequence.current += 1;
        setMentionQuery(null);
        setFileMatches([]);
        setSearchError("");
        return true;
      }
      if (event.key === "Enter" && fileMatches[activeFileIndex]) {
        event.preventDefault();
        selectFile(fileMatches[activeFileIndex]);
        return true;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitRef.current();
      return true;
    }
    return false;
  };
  keyDownRef.current = onComposerKeyDown;

  const submit = async () => {
    if (!editor) return;
    const editorParts = trimEditorMessageParts(
      extractEditorMessageParts(editor),
    );
    const draft = serializeEditorMessageParts(editorParts, "display");
    const currentAttachments = attachmentsRef.current;
    if ((!draft && !currentAttachments.length) || sending) return;
    const slashCommand = slashCommands.find(
      (candidate) => candidate.label === draft,
    );
    if (slashCommand) {
      await executeSlashCommand(slashCommand.command);
      return;
    }
    if (/^\/[a-z-]+$/i.test(draft)) {
      setComposerError(`Unknown command: ${draft}`);
      return;
    }
    const submissionThreadId = thread.id;
    setSending(true);
    setComposerError("");
    setMentionQuery(null);

    try {
      let preparedAttachments = currentAttachments;
      const unsaved = preparedAttachments.filter((item) => !item.saved);
      if (unsaved.length) {
        if (!onSaveImageAttachments) {
          throw new Error("Image attachment saving is unavailable.");
        }
        const inputs = await Promise.all(
          unsaved.map(
            async (attachment): Promise<ImageAttachmentInput> => ({
              mimeType: attachment.file
                .type as SupportedImageAttachmentMimeType,
              base64: await fileAsBase64(attachment.file),
            }),
          ),
        );
        const saved = await onSaveImageAttachments(submissionThreadId, inputs);
        if (saved.length !== unsaved.length) {
          throw new Error("Walle did not save every image attachment.");
        }
        let savedIndex = 0;
        preparedAttachments = preparedAttachments.map((attachment) =>
          attachment.saved
            ? attachment
            : { ...attachment, saved: saved[savedIndex++] },
        );
        if (activeThreadId.current !== submissionThreadId) return;
        replaceAttachments(preparedAttachments);
      }

      const modelPrompt =
        serializeEditorMessageParts(editorParts, "model") ||
        "Please inspect the attached image files and help me.";
      const savedAttachments = preparedAttachments
        .map((attachment) => attachment.saved)
        .filter((attachment): attachment is SavedImageAttachment =>
          Boolean(attachment),
        );
      let displayParts = toUserMessageParts(editorParts);
      if (savedAttachments.length) {
        const prefix = displayParts.length ? "\n\n" : "";
        displayParts = appendUserMessageText(
          displayParts,
          `${prefix}Attached images:\n${preparedAttachments
            .map((attachment) => `- ${safeDisplayName(attachment.file.name)}`)
            .join("\n")}`,
        );
      }
      const displayPrompt = serializeUserMessageParts(displayParts);

      if (running)
        await onSend(
          modelPrompt,
          displayPrompt,
          savedAttachments,
          displayParts,
          followUpMode,
        );
      else
        await onSend(
          modelPrompt,
          displayPrompt,
          savedAttachments,
          displayParts,
        );
      if (activeThreadId.current !== submissionThreadId) return;
      editor.commands.clearContent(true);
      setDraftText("");
      revokeAttachments(preparedAttachments);
      replaceAttachments([]);
    } catch (error) {
      if (activeThreadId.current === submissionThreadId) {
        setComposerError(errorText(error));
      }
    } finally {
      if (activeThreadId.current === submissionThreadId) setSending(false);
    }
  };
  submitRef.current = () => void submit();

  editorUpdateRef.current = (currentEditor) => {
    const parts = trimEditorMessageParts(
      extractEditorMessageParts(currentEditor),
    );
    setDraftText(serializeEditorMessageParts(parts, "display"));
    setComposerError("");
    updateCompletionQuery(currentEditor);
  };

  return (
    <div className="mx-auto w-full max-w-[820px] px-5 pb-4 max-[720px]:px-3">
      {pendingMessages.length > 0 && (
        <div className="mb-2 space-y-1" aria-label="Pending messages">
          {pendingMessages.map((message) => (
            <div
              key={message.id}
              className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs"
            >
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {message.mode === "steer" && running ? "Steering…" : "Queued"}
              </span>
              <span
                className="min-w-0 flex-1 truncate"
                title={message.displayPrompt}
              >
                {message.displayPrompt}
              </span>
              {onPendingMessageAction &&
                !(message.mode === "steer" && running) && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-[10px]"
                      onClick={() =>
                        void onPendingMessageAction(
                          message.id,
                          running ? "steer" : "send",
                        ).catch((error) => setComposerError(errorText(error)))
                      }
                    >
                      {running ? "Steer" : "Send now"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6"
                      aria-label="Remove queued message"
                      onClick={() =>
                        void onPendingMessageAction(message.id, "remove").catch(
                          (error) => setComposerError(errorText(error)),
                        )
                      }
                    >
                      <IconX className="size-3" />
                    </Button>
                  </>
                )}
            </div>
          ))}
        </div>
      )}
      <div
        className={cn(
          "relative overflow-visible rounded-[15px] border border-border/90 bg-[var(--composer)] shadow-[0_8px_30px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.04)] transition-shadow",
          focused &&
            "focus-within:border-foreground/20 focus-within:shadow-[0_10px_35px_rgba(0,0,0,0.075),0_1px_2px_rgba(0,0,0,0.05)]",
        )}
      >
        <div className="flex h-8 items-center gap-2 rounded-t-[14px] border-b border-border/55 bg-muted/28 px-3 text-[11px] text-muted-foreground">
          <Tooltip>
            <TooltipTrigger
              render={
                onChangeWorkspace ? (
                  <button
                    type="button"
                    onClick={onChangeWorkspace}
                    className="flex min-w-0 items-center gap-1.5 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
                    aria-label={`Change workspace, current ${thread.workspaceName}`}
                  />
                ) : (
                  <span
                    tabIndex={0}
                    className="flex min-w-0 items-center gap-1.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    aria-label={`Workspace ${thread.workspaceName}: ${thread.workspaceRoot}`}
                  />
                )
              }
            >
              <IconFolder className="size-3.5 shrink-0" />
              <span className="truncate">{thread.workspaceName}</span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[min(520px,80vw)]">
              <span className="break-all font-mono text-[10px]">
                {thread.workspaceRoot}
              </span>
            </TooltipContent>
          </Tooltip>

          <div
            className="ml-auto hidden h-4 min-w-0 max-w-[58%] overflow-hidden text-right text-[10px] text-muted-foreground/72 min-[640px]:block"
            aria-hidden="true"
          >
            <span
              key={composerTips[tipIndex]}
              className="walle-composer-tip block truncate leading-4"
            >
              {composerTips[tipIndex]}
            </span>
          </div>
        </div>

        {attachments.length > 0 && (
          <div
            className="flex gap-2 overflow-x-auto border-b border-border/55 px-3 py-2.5"
            aria-label="Image attachments"
          >
            {attachments.map((attachment) => (
              <figure
                key={attachment.id}
                className="group relative size-16 shrink-0 overflow-hidden rounded-lg border border-border/70 bg-muted"
              >
                <img
                  src={attachment.previewUrl}
                  alt={safeDisplayName(attachment.file.name)}
                  className="size-full object-cover"
                />
                {sending && !attachment.saved && (
                  <span className="absolute inset-0 flex items-center justify-center bg-background/65">
                    <IconLoader2 className="size-4 animate-spin" />
                  </span>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  size="icon-xs"
                  className="absolute right-1 top-1 size-5 rounded-full bg-background/90 opacity-90 shadow-sm group-hover:opacity-100"
                  aria-label={`Remove ${safeDisplayName(attachment.file.name)}`}
                  disabled={sending}
                  onClick={() => removeAttachment(attachment.id)}
                >
                  <IconX className="size-3" />
                </Button>
                <figcaption className="sr-only">
                  {safeDisplayName(attachment.file.name)}
                </figcaption>
              </figure>
            ))}
          </div>
        )}

        <EditorContent editor={editor} className="cursor-text" />

        {slashOpen && (
          <div
            id={slashListId}
            role="listbox"
            aria-label="Slash commands"
            className="absolute bottom-[46px] left-3 right-3 z-30 overflow-hidden rounded-xl border border-border/75 bg-popover p-1.5 text-popover-foreground shadow-xl"
          >
            <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-medium text-muted-foreground">
              <IconSlash className="size-3" /> Commands
            </div>
            {matchingSlashCommands.length ? (
              matchingSlashCommands.map((command, index) => (
                <button
                  key={command.command}
                  id={`${slashListId}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === activeSlashIndex}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[11px] outline-none",
                    index === activeSlashIndex
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/60",
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveSlashIndex(index)}
                  onClick={() => selectSlashCommand(command.command)}
                >
                  {command.command === "clear" ? (
                    <IconTrash className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <IconArrowsMinimize className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="w-16 shrink-0 font-mono text-[11px]">
                    {command.label}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {command.description}
                  </span>
                </button>
              ))
            ) : (
              <p className="px-2 py-2 text-[11px] text-muted-foreground">
                No matching commands
              </p>
            )}
          </div>
        )}

        {mentionOpen && (
          <div
            id={fileListId}
            role="listbox"
            aria-label="Workspace files"
            className="absolute bottom-[46px] left-3 right-3 z-30 max-h-56 overflow-y-auto rounded-xl border border-border/75 bg-popover p-1.5 text-popover-foreground shadow-xl"
          >
            <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-medium text-muted-foreground">
              <IconAt className="size-3" /> Workspace files
              {searchingFiles && (
                <IconLoader2 className="ml-auto size-3 animate-spin" />
              )}
            </div>
            {searchError ? (
              <p
                className="px-2 py-2 text-[11px] text-destructive"
                role="alert"
              >
                {searchError}
              </p>
            ) : !searchingFiles && fileMatches.length === 0 ? (
              <p className="px-2 py-2 text-[11px] text-muted-foreground">
                No matching files
              </p>
            ) : (
              fileMatches.map((match, index) => (
                <button
                  key={match.relativePath}
                  id={`${fileListId}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === activeFileIndex}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] outline-none",
                    index === activeFileIndex
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/60",
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveFileIndex(index)}
                  onClick={() => selectFile(match)}
                >
                  <IconFile className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">
                    {match.relativePath}
                  </span>
                </button>
              ))
            )}
          </div>
        )}

        {(composerError || sending) && (
          <div
            className={cn(
              "border-t border-border/45 px-3 py-1.5 text-[10px]",
              composerError ? "text-destructive" : "text-muted-foreground",
            )}
            role={composerError ? "alert" : "status"}
            aria-live="polite"
          >
            {composerError || "Preparing the request…"}
          </div>
        )}

        <div className="flex h-10 items-center gap-1 rounded-b-[14px] px-2.5 pb-1.5">
          <input
            ref={fileInputRef}
            type="file"
            accept={SUPPORTED_IMAGE_ATTACHMENT_MIME_TYPES.join(",")}
            multiple
            className="sr-only"
            aria-label="Choose image attachments"
            onChange={onFilesSelected}
          />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Attach images"
                  disabled={sending}
                  onClick={() => fileInputRef.current?.click()}
                />
              }
            >
              <IconPaperclip />
            </TooltipTrigger>
            <TooltipContent>
              Attach images ({MAX_IMAGE_ATTACHMENTS} max)
            </TooltipContent>
          </Tooltip>

          {attachments.length > 0 && (
            <span className="flex items-center gap-1 px-1 text-[10px] text-muted-foreground">
              <IconPhoto className="size-3" /> {attachments.length}
            </span>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={
                    currentModel
                      ? `Select provider and model, current ${currentModelLabel}`
                      : "Select provider and model"
                  }
                  className="max-w-[240px] gap-1 px-1.5 font-normal text-muted-foreground"
                  disabled={running || sending}
                />
              }
            >
              <span className="truncate">{currentModelLabel}</span>
              <IconChevronDown className="size-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuGroup>
                {providers.flatMap((profile) =>
                  providerModels(profile).map((entry) => (
                    <Tooltip key={`${profile.id}:${entry.value}`}>
                      <TooltipTrigger
                        render={
                          <DropdownMenuItem
                            onClick={() =>
                              void onProviderChange(profile.id, entry.value)
                            }
                          />
                        }
                      >
                        <span className="size-1.5 shrink-0 rounded-full bg-[var(--brand)]" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs">
                            {entry.label || entry.value}
                          </span>
                          {entry.description && (
                            <span className="block whitespace-normal text-[10px] text-muted-foreground">
                              {entry.description}
                            </span>
                          )}
                        </span>
                        {profile.id === thread.providerProfileId &&
                          entry.value === currentModel && (
                            <IconCheck
                              className="size-3.5 shrink-0"
                              aria-label="Selected model"
                            />
                          )}
                      </TooltipTrigger>
                      <TooltipContent
                        side="right"
                        align="start"
                        className="max-w-80 flex-col items-start gap-1"
                      >
                        <span className="font-medium">
                          {entry.label || entry.value}
                        </span>
                        <span>
                          Provider: {profile.name} · {profile.kind}
                        </span>
                        <span className="break-all font-mono text-[10px]">
                          Model ID: {entry.value}
                        </span>
                        {entry.description && <span>{entry.description}</span>}
                      </TooltipContent>
                    </Tooltip>
                  )),
                )}
                {providers.length === 0 && (
                  <DropdownMenuItem disabled>
                    No provider configured
                  </DropdownMenuItem>
                )}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu
            open={permissionMenuOpen}
            onOpenChange={setPermissionMenuOpen}
          >
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Select approval policy, current ${permissionLabels[permissionMode]}`}
                  className={cn(
                    "max-w-[190px] gap-1 px-1.5 font-normal text-muted-foreground",
                    permissionMode === "full-access" &&
                      "bg-red-50 text-red-400 hover:bg-red-100 hover:text-red-500 dark:bg-red-950/30 dark:text-red-300",
                  )}
                  disabled={running || sending}
                />
              }
            >
              <IconShieldCheck className="size-3.5" />
              <span className="hidden truncate text-[10px] min-[620px]:inline">
                {permissionLabels[permissionMode]}
              </span>
              <IconChevronDown className="size-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-52">
              <DropdownMenuGroup>
                <DropdownMenuRadioGroup
                  value={permissionMode}
                  onValueChange={(mode) => {
                    setPermissionMenuOpen(false);
                    void onPermissionModeChange(mode as PermissionMode);
                  }}
                >
                  <DropdownMenuRadioItem value="ask">
                    Ask before actions
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="auto">
                    Approve automatically
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="deny-high-risk">
                    Deny high-risk
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem
                    value="full-access"
                    className="text-red-400 data-highlighted:bg-red-50 data-highlighted:text-red-500 dark:text-red-300 dark:data-highlighted:bg-red-950/30"
                  >
                    Full Access
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="ml-auto flex items-center gap-1">
            <ContextWindowMeter
              usedTokens={contextWindow?.usedTokens}
              inputTokens={contextWindow?.inputTokens}
              outputTokens={contextWindow?.outputTokens}
              cacheReadTokens={contextWindow?.cacheReadTokens}
              cacheWriteTokens={contextWindow?.cacheWriteTokens}
              maxTokens={contextWindow?.maxTokens ?? maxContextTokens}
              source={contextWindow?.source}
            />

            {running && (
              <>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1 px-2 text-xs text-muted-foreground"
                        aria-label="Follow-up behavior"
                      />
                    }
                  >
                    {followUpMode === "queue" ? "Queue" : "Steer"}
                    <IconChevronDown className="size-3" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-64">
                    <DropdownMenuRadioGroup
                      value={followUpMode}
                      onValueChange={(value) => {
                        const mode = value as FollowUpMode;
                        void onFollowUpModeChange?.(mode);
                      }}
                    >
                      <DropdownMenuRadioItem value="queue">
                        <span>
                          Queue
                          <span className="block text-[10px] text-muted-foreground">
                            Send after the current response finishes
                          </span>
                        </span>
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="steer">
                        <span>
                          Steer
                          <span className="block text-[10px] text-muted-foreground">
                            Guide the task in progress
                          </span>
                        </span>
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 rounded-full"
                  onClick={() => void onStop()}
                  aria-label="Stop run"
                >
                  <IconPlayerStopFilled className="size-3" />
                </Button>
              </>
            )}
            <Button
              size="icon"
              className="size-7 rounded-full"
              disabled={!canSubmit || sending}
              onClick={() => void submit()}
              aria-label={
                running
                  ? followUpMode === "queue"
                    ? "Queue message"
                    : "Steer run"
                  : "Send message"
              }
            >
              {sending ? (
                <IconLoader2 className="size-4 animate-spin" />
              ) : (
                <IconArrowUp className="size-4" />
              )}
            </Button>
          </div>
        </div>
      </div>
      <p className="mt-1.5 text-center text-[10px] text-muted-foreground/65">
        Walle can make mistakes. Review changes before committing.
      </p>
    </div>
  );
}
