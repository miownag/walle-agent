import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceBoundary } from "../workspace-boundary";

describe("WorkspaceBoundary", () => {
  let parent: string;
  let root: string;
  let outside: string;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "walle-boundary-"));
    root = join(parent, "workspace");
    outside = join(parent, "outside");
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(root, "src", "inside.ts"), "export {};\n");
    await writeFile(join(outside, "secret.txt"), "secret\n");
    await symlink(join(outside, "secret.txt"), join(root, "linked-secret.txt"));
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it("allows real paths inside the workspace", async () => {
    const boundary = await WorkspaceBoundary.create(root);
    await expect(boundary.assertFile("src/inside.ts")).resolves.toBe(
      join(boundary.root, "src", "inside.ts"),
    );
    await expect(boundary.assertDirectory("src")).resolves.toBe(
      join(boundary.root, "src"),
    );
  });

  it("rejects traversal, absolute input, and symlink escapes", async () => {
    const boundary = await WorkspaceBoundary.create(root);
    await expect(
      boundary.resolveExisting("../outside/secret.txt"),
    ).rejects.toThrow(/escapes/i);
    await expect(
      boundary.resolveExisting(join(outside, "secret.txt")),
    ).rejects.toThrow(/relative/i);
    await expect(boundary.resolveExisting("linked-secret.txt")).rejects.toThrow(
      /outside/i,
    );
  });
});
