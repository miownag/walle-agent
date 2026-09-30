import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ImageAttachmentInput } from "../../shared/contracts";
import { DEFAULT_SETTINGS } from "../defaults";
import { WorkspaceService } from "../workspace-service";

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);

function pngInput(): ImageAttachmentInput {
  return { mimeType: "image/png", base64: PNG_BYTES.toString("base64") };
}

describe("WorkspaceService attachments and file search", () => {
  let parent: string;
  let root: string;
  let outside: string;
  let service: WorkspaceService;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "walle-workspace-service-"));
    root = join(parent, "workspace");
    outside = join(parent, "outside");
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await mkdir(join(root, "node_modules", "package"), { recursive: true });
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, ".walle", "attachments"), { recursive: true });
    await mkdir(outside, { recursive: true });
    root = await realpath(root);
    outside = await realpath(outside);
    await writeFile(join(root, "src", "agent.ts"), "export {}\n");
    await writeFile(join(root, "src", "nested", "agent.test.ts"), "test()\n");
    await writeFile(
      join(root, "node_modules", "package", "agent.js"),
      "ignored\n",
    );
    await writeFile(join(root, ".git", "agent-config"), "ignored\n");
    await writeFile(
      join(root, ".walle", "attachments", "agent.png"),
      PNG_BYTES,
    );
    await writeFile(join(outside, "agent-secret.ts"), "secret\n");
    await symlink(
      join(outside, "agent-secret.ts"),
      join(root, "linked-agent.ts"),
    );
    service = new WorkspaceService(() => structuredClone(DEFAULT_SETTINGS));
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it("returns bounded canonical matches and skips symlinks and generated directories", async () => {
    for (let index = 0; index < 40; index += 1) {
      await writeFile(join(root, "src", `agent-${index}.ts`), "export {}\n");
    }

    const matches = await service.searchFiles(root, "agent");
    const exactMatches = await service.searchFiles(root, "agent.ts");

    expect(matches.length).toBeLessThanOrEqual(30);
    expect(exactMatches).toContainEqual({
      name: "agent.ts",
      relativePath: join("src", "agent.ts"),
      path: join(root, "src", "agent.ts"),
    });
    expect(matches.some((match) => match.path.includes("node_modules"))).toBe(
      false,
    );
    expect(
      matches.some((match) => match.path.includes(`${join(root, ".git")}`)),
    ).toBe(false);
    expect(
      matches.some((match) => match.path.includes(`${join(root, ".walle")}`)),
    ).toBe(false);
    expect(
      matches.some((match) => match.path === join(root, "linked-agent.ts")),
    ).toBe(false);
    expect(matches.every((match) => match.path.startsWith(`${root}/`))).toBe(
      true,
    );
  });

  it("expands structured file references through the workspace boundary", async () => {
    await expect(
      service.expandUserMessageParts(root, [
        { type: "text", text: "Review " },
        { type: "file", name: "agent.ts", relativePath: "src/agent.ts" },
        { type: "text", text: " carefully" },
      ]),
    ).resolves.toBe(`Review ${join(root, "src", "agent.ts")} carefully`);

    await expect(
      service.expandUserMessageParts(root, [
        {
          type: "file",
          name: "secret",
          relativePath: "linked-agent.ts",
        },
      ]),
    ).rejects.toThrow(/outside the workspace/i);
    await expect(
      service.expandUserMessageParts(root, [
        { type: "file", name: "escape", relativePath: "../outside" },
      ]),
    ).rejects.toThrow(/escapes the workspace/i);
  });

  it("atomically saves validated images with main-controlled names", async () => {
    const saved = await service.saveImageAttachments(root, [pngInput()]);

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      mimeType: "image/png",
      size: PNG_BYTES.length,
    });
    expect(saved[0].fileName).toMatch(/^\d+-[0-9a-f-]+\.png$/);
    expect(saved[0].path).toBe(
      join(root, ".walle", "attachments", saved[0].fileName),
    );
    expect(saved[0].relativePath).toBe(
      join(".walle", "attachments", saved[0].fileName),
    );
    expect(await readFile(saved[0].path)).toEqual(PNG_BYTES);
    expect(
      (await readdir(join(root, ".walle", "attachments"))).some((name) =>
        name.startsWith(".tmp-"),
      ),
    ).toBe(false);
  });

  it("reloads saved images as transient core attachments", async () => {
    const [saved] = await service.saveImageAttachments(root, [pngInput()]);

    await expect(service.loadImageAttachments(root, [saved])).resolves.toEqual([
      {
        type: "image",
        name: saved.fileName,
        mimeType: "image/png",
        data: PNG_BYTES,
      },
    ]);
  });

  it("rejects forged or changed saved attachment descriptors", async () => {
    const [saved] = await service.saveImageAttachments(root, [pngInput()]);

    await expect(
      service.loadImageAttachments(root, [
        { ...saved, path: join(outside, "agent-secret.ts") },
      ]),
    ).rejects.toThrow(/owned by this workspace/i);
    await expect(
      service.loadImageAttachments(root, [{ ...saved, size: saved.size + 1 }]),
    ).rejects.toThrow(/changed before sending/i);

    await writeFile(saved.path, Buffer.from("not an image"));
    await expect(
      service.loadImageAttachments(root, [
        { ...saved, size: Buffer.byteLength("not an image") },
      ]),
    ).rejects.toThrow(/content is invalid/i);
  });

  it("rejects an oversized aggregate before reading attachment files", async () => {
    const [saved] = await service.saveImageAttachments(root, [pngInput()]);
    const claimedSize = 4 * 1024 * 1024;

    await expect(
      service.loadImageAttachments(
        root,
        Array.from({ length: 4 }, () => ({
          ...saved,
          size: claimedSize,
        })),
      ),
    ).rejects.toThrow(/at most 15 MB together/i);
  });

  it("rejects malformed base64, MIME spoofing, and the whole invalid batch", async () => {
    await expect(
      service.saveImageAttachments(root, [
        pngInput(),
        { mimeType: "image/png", base64: "not/base64" },
      ]),
    ).rejects.toThrow(/data|encoding/i);
    await expect(
      service.saveImageAttachments(root, [
        {
          mimeType: "image/jpeg",
          base64: PNG_BYTES.toString("base64"),
        },
      ]),
    ).rejects.toThrow(/MIME/i);
    expect(await readdir(join(root, ".walle", "attachments"))).toEqual([
      "agent.png",
    ]);
  });

  it("rejects an attachment directory that is a symlink outside the workspace", async () => {
    const unsafeRoot = join(parent, "unsafe-workspace");
    await mkdir(join(unsafeRoot, ".walle"), { recursive: true });
    await symlink(outside, join(unsafeRoot, ".walle", "attachments"));

    await expect(
      service.saveImageAttachments(unsafeRoot, [pngInput()]),
    ).rejects.toThrow(/symlink/i);
    expect(await readdir(outside)).toEqual(["agent-secret.ts"]);
  });
});
