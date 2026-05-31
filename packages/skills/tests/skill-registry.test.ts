import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SkillFileStore } from "../src/skill-file-store.js";
import { SkillRegistry } from "../src/skill-registry.js";
import type { Skill } from "../src/skill-types.js";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "walle-skill-reg-"));
}

function mkSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: overrides.id ?? `skill-${Math.random().toString(36).slice(2)}`,
    name: "Deploy Next.js to Vercel",
    description: "Standard procedure for deploying a Next.js app to Vercel",
    type: "prompt",
    content: "1. pnpm test\n2. pnpm build\n3. vercel --prod",
    tags: ["deploy", "vercel"],
    trigger: { keywords: ["deploy", "vercel", "nextjs"] },
    metadata: {
      createdBy: "human",
      createdAt: new Date().toISOString(),
      usageCount: 0,
      successCount: 0,
      confidence: 0.9,
    },
    ...overrides,
  };
}

function mkRegistry(projectDir: string, userDir?: string): SkillRegistry {
  const project = new SkillFileStore(projectDir, "project");
  const user = userDir ? new SkillFileStore(userDir, "user") : undefined;
  return new SkillRegistry({ project, user });
}

describe("SkillRegistry", () => {
  let projectDir: string;
  let userDir: string;

  beforeEach(async () => {
    projectDir = await tmpDir();
    userDir = await tmpDir();
  });

  it("loads persisted skills on init", async () => {
    const store = new SkillFileStore(projectDir, "project");
    const s = mkSkill();
    await store.save(s);

    const reg = mkRegistry(projectDir);
    await reg.loadAll();
    expect(reg.list()).toHaveLength(1);
    expect(reg.get(s.name)?.name).toBe(s.name);
    expect(reg.get(s.name)?.scope).toBe("project");
  });

  it("registers skills and persists them to the project store", async () => {
    const reg = mkRegistry(projectDir);
    const s = mkSkill();
    await reg.register(s);

    const onDisk = await new SkillFileStore(projectDir, "project").listAll();
    expect(onDisk.map((x) => x.name)).toEqual([s.name]);
    expect(onDisk[0].scope).toBe("project");
  });

  it("markUsed bumps usageCount and lastUsedAt", async () => {
    const reg = mkRegistry(projectDir);
    const s = mkSkill();
    await reg.register(s);

    reg.markUsed(s.name);
    const after = reg.get(s.name)!;
    expect(after.metadata.usageCount).toBe(1);
    expect(after.metadata.lastUsedAt).toBeTruthy();
  });

  it("markUsed is a no-op for unknown skills", async () => {
    const reg = mkRegistry(projectDir);
    expect(() => reg.markUsed("nope")).not.toThrow();
  });

  it("get accepts both raw name and slug", async () => {
    const reg = mkRegistry(projectDir);
    await reg.register(mkSkill({ name: "Deploy To Vercel" }));
    expect(reg.get("Deploy To Vercel")).toBeDefined();
    expect(reg.get("deploy-to-vercel")).toBeDefined();
  });

  it("remove deletes from memory and disk", async () => {
    const reg = mkRegistry(projectDir);
    const s = mkSkill();
    await reg.register(s);
    await reg.remove(s.name);

    expect(reg.get(s.name)).toBeUndefined();
    expect(await new SkillFileStore(projectDir, "project").listAll()).toHaveLength(0);
  });

  it("update materialises a project-scope copy even when patching a user-scope skill", async () => {
    const userStore = new SkillFileStore(userDir, "user");
    await userStore.save(
      mkSkill({ id: "user-skill", name: "User Skill", description: "original" }),
    );
    const reg = mkRegistry(projectDir, userDir);
    await reg.loadAll();

    const updated = await reg.update("User Skill", { description: "patched" });
    expect(updated?.description).toBe("patched");
    expect(updated?.scope).toBe("project");
    const onProject = await new SkillFileStore(projectDir, "project").listAll();
    expect(onProject.map((s) => s.name)).toEqual(["User Skill"]);
  });

  it("merges project + user scopes, with project winning on slug collision", async () => {
    const userStore = new SkillFileStore(userDir, "user");
    await userStore.save(
      mkSkill({
        id: "user-deploy",
        name: "Deploy Next.js to Vercel",
        description: "[USER version]",
      }),
    );
    await userStore.save(
      mkSkill({
        id: "user-only",
        name: "Run tests (user scope)",
        description: "user-only skill",
      }),
    );

    const projectStore = new SkillFileStore(projectDir, "project");
    await projectStore.save(
      mkSkill({
        id: "project-deploy",
        name: "Deploy Next.js to Vercel",
        description: "[PROJECT version]",
      }),
    );

    const reg = mkRegistry(projectDir, userDir);
    await reg.loadAll();

    expect(reg.list()).toHaveLength(2);
    const deploy = reg.get("Deploy Next.js to Vercel");
    expect(deploy?.description).toBe("[PROJECT version]");
    expect(deploy?.scope).toBe("project");
    const userOnly = reg.get("Run tests (user scope)");
    expect(userOnly?.scope).toBe("user");
  });
});
