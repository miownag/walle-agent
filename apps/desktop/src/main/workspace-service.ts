import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  type FileHandle,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Attachment } from "@walle-agent/core";
import {
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES,
  SUPPORTED_IMAGE_ATTACHMENT_MIME_TYPES,
  type AppSettings,
  type CommandResult,
  type FileEntry,
  type FilePreview,
  type ImageAttachmentInput,
  type SavedImageAttachment,
  type SupportedImageAttachmentMimeType,
  type UserMessagePart,
  type WorkspaceFileMatch,
} from "../shared/contracts";
import { WorkspaceBoundary } from "./workspace-boundary";
import { WorkspaceSandbox } from "./workspace-sandbox";

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_FILE_SEARCH_RESULTS = 30;
const MAX_FILE_SEARCH_CANDIDATES = 180;
const MAX_FILE_SEARCH_DEPTH = 8;
const MAX_FILE_SEARCH_ENTRIES = 5_000;
const MAX_FILE_SEARCH_MS = 180;
const IGNORED_SEARCH_DIRECTORIES = new Set([
  ".git",
  ".walle",
  ".next",
  ".cache",
  "node_modules",
  "dist",
  "out",
  "build",
  "coverage",
]);
const ATTACHMENT_EXTENSION: Record<SupportedImageAttachmentMimeType, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

interface DecodedImageAttachment {
  mimeType: SupportedImageAttachmentMimeType;
  bytes: Buffer;
}

function nodeErrorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function isSupportedImageMimeType(
  value: string,
): value is SupportedImageAttachmentMimeType {
  return (SUPPORTED_IMAGE_ATTACHMENT_MIME_TYPES as readonly string[]).includes(
    value,
  );
}

function hasExpectedImageSignature(
  mimeType: SupportedImageAttachmentMimeType,
  bytes: Buffer,
): boolean {
  if (mimeType === "image/png") {
    return (
      bytes.length >= 8 &&
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    );
  }
  if (mimeType === "image/jpeg") {
    return (
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
    );
  }
  if (mimeType === "image/gif") {
    if (bytes.length < 6) return false;
    const header = bytes.subarray(0, 6).toString("ascii");
    return header === "GIF87a" || header === "GIF89a";
  }
  return (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

function decodeImageAttachment(
  input: ImageAttachmentInput,
): DecodedImageAttachment {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid image attachment");
  }
  if (
    typeof input.mimeType !== "string" ||
    !isSupportedImageMimeType(input.mimeType)
  ) {
    throw new Error("Unsupported image attachment type");
  }
  if (
    typeof input.base64 !== "string" ||
    !input.base64 ||
    input.base64.length > 4 * Math.ceil(MAX_IMAGE_ATTACHMENT_BYTES / 3) ||
    input.base64.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      input.base64,
    )
  ) {
    throw new Error("Invalid image attachment data");
  }
  const bytes = Buffer.from(input.base64, "base64");
  if (
    !bytes.length ||
    bytes.length > MAX_IMAGE_ATTACHMENT_BYTES ||
    bytes.toString("base64") !== input.base64
  ) {
    throw new Error("Invalid image attachment size or encoding");
  }
  if (!hasExpectedImageSignature(input.mimeType, bytes)) {
    throw new Error("Image attachment content does not match its MIME type");
  }
  return { mimeType: input.mimeType, bytes };
}

async function readExactFile(
  handle: FileHandle,
  expectedBytes: number,
): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(expectedBytes);
  let offset = 0;
  while (offset < expectedBytes) {
    const result = await handle.read(
      bytes,
      offset,
      expectedBytes - offset,
      offset,
    );
    if (!result.bytesRead) {
      throw new Error("Saved image attachment changed before sending");
    }
    offset += result.bytesRead;
  }
  const overflow = Buffer.allocUnsafe(1);
  const extra = await handle.read(overflow, 0, 1, expectedBytes);
  if (extra.bytesRead) {
    throw new Error("Saved image attachment changed before sending");
  }
  return bytes;
}

async function ensureSafeDirectory(
  boundary: WorkspaceBoundary,
  directory: string,
): Promise<string> {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (nodeErrorCode(error) !== "EEXIST") throw error;
  }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Attachment directory must not be a symlink");
  }
  const canonical = await realpath(directory);
  if (!boundary.contains(canonical)) {
    throw new Error("Attachment directory escapes the workspace root");
  }
  return canonical;
}

function searchScore(relativePath: string, query: string): number {
  if (!query) return 4;
  const path = relativePath.toLowerCase();
  const name = basename(path);
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (path.startsWith(query)) return 3;
  return 4;
}

function languageFor(filePath: string): string {
  const extension = filePath.split(".").pop()?.toLowerCase();
  return (
    (
      {
        ts: "typescript",
        tsx: "tsx",
        js: "javascript",
        jsx: "jsx",
        json: "json",
        md: "markdown",
        css: "css",
        scss: "scss",
        html: "html",
        yaml: "yaml",
        yml: "yaml",
        py: "python",
        rs: "rust",
        go: "go",
        java: "java",
        kt: "kotlin",
        swift: "swift",
        sh: "shell",
        zsh: "shell",
        toml: "toml",
        xml: "xml",
        sql: "sql",
      } as Record<string, string>
    )[extension ?? ""] ?? "text"
  );
}

export class WorkspaceService {
  private readonly commandControllers = new Set<AbortController>();
  private readonly commandRuns = new Set<Promise<unknown>>();

  constructor(private readonly getSettings: () => AppSettings) {}

  async canonicalRoot(workspaceRoot: string): Promise<string> {
    return (await WorkspaceBoundary.create(workspaceRoot)).root;
  }

  async readDirectory(
    workspaceRoot: string,
    relativePath = "",
  ): Promise<FileEntry[]> {
    const boundary = await WorkspaceBoundary.create(workspaceRoot);
    const directory = await boundary.assertDirectory(relativePath);
    const entries = await readdir(directory, { withFileTypes: true });
    const result = await Promise.all(
      entries.map(async (entry): Promise<FileEntry> => {
        const fullPath = join(directory, entry.name);
        const info = await boundary.describeEntry(fullPath);
        const item: FileEntry = {
          name: entry.name,
          path: fullPath,
          relativePath: boundary.relative(fullPath),
          kind: entry.isSymbolicLink()
            ? "symlink"
            : entry.isDirectory()
              ? "directory"
              : "file",
          modifiedAt: info.mtime.toISOString(),
        };
        if (entry.isFile()) item.size = Number(info.size);
        return item;
      }),
    );
    return result.sort((a, b) => {
      if (a.kind === "directory" && b.kind !== "directory") return -1;
      if (b.kind === "directory" && a.kind !== "directory") return 1;
      return a.name.localeCompare(b.name);
    });
  }

  async readFile(
    workspaceRoot: string,
    relativePath: string,
  ): Promise<FilePreview> {
    const boundary = await WorkspaceBoundary.create(workspaceRoot);
    const target = await boundary.assertFile(relativePath);
    const info = await stat(target);
    const length = Math.min(info.size, MAX_PREVIEW_BYTES);
    const slice = Buffer.alloc(length);
    const handle = await open(target, "r");
    try {
      await handle.read(slice, 0, length, 0);
    } finally {
      await handle.close();
    }
    if (slice.includes(0))
      throw new Error("Binary files cannot be previewed as text");
    return {
      path: target,
      relativePath: boundary.relative(target),
      content: slice.toString("utf8"),
      language: languageFor(target),
      truncated: info.size > slice.byteLength,
      totalBytes: info.size,
    };
  }

  async searchFiles(
    workspaceRoot: string,
    rawQuery: string,
  ): Promise<WorkspaceFileMatch[]> {
    const boundary = await WorkspaceBoundary.create(workspaceRoot);
    const query = rawQuery.trim().toLowerCase();
    const startedAt = Date.now();
    const queue: Array<{ relativePath: string; depth: number }> = [
      { relativePath: "", depth: 0 },
    ];
    const candidates: WorkspaceFileMatch[] = [];
    let visited = 0;

    while (
      queue.length &&
      visited < MAX_FILE_SEARCH_ENTRIES &&
      candidates.length < MAX_FILE_SEARCH_CANDIDATES &&
      Date.now() - startedAt < MAX_FILE_SEARCH_MS
    ) {
      const current = queue.shift();
      if (!current) break;
      let directory: string;
      try {
        directory = await boundary.assertDirectory(current.relativePath);
      } catch (error) {
        if (!current.relativePath) throw error;
        continue;
      }
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (!current.relativePath) throw error;
        continue;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));

      for (const entry of entries) {
        visited += 1;
        if (
          visited > MAX_FILE_SEARCH_ENTRIES ||
          Date.now() - startedAt >= MAX_FILE_SEARCH_MS
        )
          break;
        if (entry.isSymbolicLink()) continue;
        const relativePath = current.relativePath
          ? join(current.relativePath, entry.name)
          : entry.name;
        if (entry.isDirectory()) {
          if (
            current.depth < MAX_FILE_SEARCH_DEPTH &&
            !IGNORED_SEARCH_DIRECTORIES.has(entry.name.toLowerCase())
          ) {
            queue.push({ relativePath, depth: current.depth + 1 });
          }
          continue;
        }
        if (!entry.isFile()) continue;
        if (query && !relativePath.toLowerCase().includes(query)) continue;
        try {
          const path = await boundary.assertFile(relativePath);
          candidates.push({
            name: entry.name,
            relativePath: boundary.relative(path),
            path,
          });
        } catch {
          // A file may have changed or become a symlink while walking.
        }
        if (candidates.length >= MAX_FILE_SEARCH_CANDIDATES) break;
      }
    }

    return candidates
      .sort((left, right) => {
        const score =
          searchScore(left.relativePath, query) -
          searchScore(right.relativePath, query);
        return score || left.relativePath.localeCompare(right.relativePath);
      })
      .slice(0, MAX_FILE_SEARCH_RESULTS);
  }

  async expandUserMessageParts(
    workspaceRoot: string,
    parts: UserMessagePart[],
  ): Promise<string> {
    const boundary = await WorkspaceBoundary.create(workspaceRoot);
    const content: string[] = [];
    for (const part of parts) {
      if (part.type === "text") {
        content.push(part.text);
        continue;
      }
      content.push(await boundary.assertFile(part.relativePath));
    }
    return content.join("");
  }

  async saveImageAttachments(
    workspaceRoot: string,
    inputs: ImageAttachmentInput[],
  ): Promise<SavedImageAttachment[]> {
    if (!Array.isArray(inputs) || !inputs.length) {
      throw new Error("At least one image attachment is required");
    }
    if (inputs.length > MAX_IMAGE_ATTACHMENTS) {
      throw new Error(
        `A message can include at most ${MAX_IMAGE_ATTACHMENTS} images`,
      );
    }
    const attachments = inputs.map(decodeImageAttachment);
    if (
      attachments.reduce(
        (total, attachment) => total + attachment.bytes.length,
        0,
      ) > MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES
    ) {
      throw new Error(
        `Image attachments can use at most ${MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES / (1024 * 1024)} MB together`,
      );
    }
    const boundary = await WorkspaceBoundary.create(workspaceRoot);
    const walleDirectory = await ensureSafeDirectory(
      boundary,
      join(boundary.root, ".walle"),
    );
    const attachmentDirectory = await ensureSafeDirectory(
      boundary,
      join(walleDirectory, "attachments"),
    );
    const saved: SavedImageAttachment[] = [];

    try {
      for (const attachment of attachments) {
        const fileName = `${Date.now()}-${randomUUID()}${ATTACHMENT_EXTENSION[attachment.mimeType]}`;
        const finalPath = join(attachmentDirectory, fileName);
        const temporaryPath = join(attachmentDirectory, `.tmp-${randomUUID()}`);
        try {
          const handle = await open(
            temporaryPath,
            fsConstants.O_WRONLY |
              fsConstants.O_CREAT |
              fsConstants.O_EXCL |
              fsConstants.O_NOFOLLOW,
            0o600,
          );
          try {
            const canonicalTemporaryPath = await realpath(temporaryPath);
            if (
              dirname(canonicalTemporaryPath) !== attachmentDirectory ||
              !boundary.contains(canonicalTemporaryPath)
            ) {
              throw new Error("Attachment staging escaped the workspace root");
            }
            await handle.writeFile(attachment.bytes);
            await handle.sync();
            const info = await handle.stat();
            if (
              !info.isFile() ||
              info.size !== attachment.bytes.length ||
              info.size > MAX_IMAGE_ATTACHMENT_BYTES
            ) {
              throw new Error("Attachment changed while it was being saved");
            }
          } finally {
            await handle.close();
          }
          if (
            (await ensureSafeDirectory(boundary, attachmentDirectory)) !==
            attachmentDirectory
          ) {
            throw new Error("Attachment directory changed while saving");
          }
          await rename(temporaryPath, finalPath);
        } catch (error) {
          await unlink(temporaryPath).catch(() => undefined);
          throw error;
        }
        const canonical = await realpath(finalPath);
        if (!boundary.contains(canonical)) {
          await unlink(finalPath).catch(() => undefined);
          throw new Error("Saved attachment escapes the workspace root");
        }
        saved.push({
          path: canonical,
          relativePath: boundary.relative(canonical),
          fileName,
          mimeType: attachment.mimeType,
          size: attachment.bytes.length,
        });
      }
      return saved;
    } catch (error) {
      await Promise.allSettled(
        saved.map((attachment) => unlink(attachment.path)),
      );
      throw error;
    }
  }

  async loadImageAttachments(
    workspaceRoot: string,
    inputs: SavedImageAttachment[],
  ): Promise<Attachment[]> {
    if (!inputs.length) return [];
    if (inputs.length > MAX_IMAGE_ATTACHMENTS) {
      throw new Error(
        `A message can include at most ${MAX_IMAGE_ATTACHMENTS} images`,
      );
    }
    if (
      inputs.reduce((total, input) => total + input.size, 0) >
      MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES
    ) {
      throw new Error(
        `Image attachments can use at most ${MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES / (1024 * 1024)} MB together`,
      );
    }
    const boundary = await WorkspaceBoundary.create(workspaceRoot);
    const attachments: Attachment[] = [];
    for (const input of inputs) {
      if (!isSupportedImageMimeType(input.mimeType)) {
        throw new Error("Unsupported saved image attachment type");
      }
      const target = await boundary.assertFile(input.relativePath);
      const relativePath = boundary.relative(target);
      const pathParts = relativePath.split(/[\\/]/);
      if (
        pathParts.length !== 3 ||
        pathParts[0] !== ".walle" ||
        pathParts[1] !== "attachments" ||
        pathParts[2] !== input.fileName ||
        target !== input.path
      ) {
        throw new Error("Image attachment is not owned by this workspace");
      }
      const handle = await open(
        target,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      try {
        const info = await handle.stat();
        const currentTarget = await realpath(target);
        if (currentTarget !== target || !boundary.contains(currentTarget)) {
          throw new Error("Image attachment moved outside this workspace");
        }
        if (
          !info.isFile() ||
          !info.size ||
          info.size > MAX_IMAGE_ATTACHMENT_BYTES ||
          info.size !== input.size
        ) {
          throw new Error("Saved image attachment changed before sending");
        }
        const bytes = await readExactFile(handle, info.size);
        const [afterHandleInfo, afterPathInfo, finalTarget] = await Promise.all(
          [handle.stat(), lstat(target), realpath(target)],
        );
        if (
          finalTarget !== target ||
          !boundary.contains(finalTarget) ||
          !afterPathInfo.isFile() ||
          afterPathInfo.isSymbolicLink() ||
          afterPathInfo.dev !== info.dev ||
          afterPathInfo.ino !== info.ino ||
          afterHandleInfo.dev !== info.dev ||
          afterHandleInfo.ino !== info.ino ||
          afterHandleInfo.size !== info.size ||
          bytes.length !== input.size
        ) {
          throw new Error("Saved image attachment changed before sending");
        }
        if (!hasExpectedImageSignature(input.mimeType, bytes)) {
          throw new Error("Saved image attachment content is invalid");
        }
        attachments.push({
          type: "image",
          name: input.fileName,
          mimeType: input.mimeType,
          data: bytes,
        });
      } finally {
        await handle.close();
      }
    }
    return attachments;
  }

  async runCommand(
    workspaceRoot: string,
    command: string,
  ): Promise<CommandResult> {
    if (!command.trim()) throw new Error("Command is required");
    const settings = this.getSettings();
    const sandbox = await WorkspaceSandbox.create(
      workspaceRoot,
      settings.sandbox,
    );
    const controller = new AbortController();
    this.commandControllers.add(controller);
    const run = sandbox.run({
      cmd: "sh",
      args: ["-c", command],
      timeoutMs: settings.sandbox.timeoutMs,
      signal: controller.signal,
    });
    this.commandRuns.add(run);
    try {
      const result = await run;
      return { command, cwd: workspaceRoot, ...result };
    } finally {
      this.commandControllers.delete(controller);
      this.commandRuns.delete(run);
      await sandbox.dispose();
    }
  }

  async dispose(): Promise<void> {
    for (const controller of this.commandControllers)
      controller.abort("desktop-shutdown");
    await Promise.allSettled([...this.commandRuns]);
  }
}
