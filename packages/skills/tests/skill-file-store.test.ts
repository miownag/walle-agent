import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { SkillFileStore } from "../src/skill-file-store.js";
import { serializeSkillMarkdown } from "../src/skill-markdown.js";
import type { Skill } from "../src/skill-types.js";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "walle-skill-store-"));
}

function mkSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: overrides.id ?? `skill-${Math.random().toString(36).slice(2)}`,
    name: "Run Tests",
    description: "Execute the project's test suite",
    type: "prompt",
    content: "pnpm test",
    tags: ["test"],
    trigger: { keywords: ["test"] },
    metadata: {
      createdBy: "human",
      createdAt: new Date().toISOString(),
      usageCount: 0,
      successCount: 0,
      confidence: 0.8,
    },
    ...overrides,
  };
}

describe("SkillFileStore", () => {
  let root: string;

  beforeEach(async () => {
    root = await tmpDir();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes SKILL.md under <root>/skills/<slug>/", async () => {
    const store = new SkillFileStore(root, "project");
    await store.save(mkSkill({ name: "Deploy To Vercel" }));
    const expected = path.join(root, "skills", "deploy-to-vercel", "SKILL.md");
    expect(existsSync(expected)).toBe(true);
    const raw = await fs.readFile(expected, "utf-8");
    expect(raw).toMatch(/^---\n/);
    expect(raw).toMatch(/\nname: Deploy To Vercel\n/);
  });

  it("round-trips a skill through save + listAll, tagging scope", async () => {
    const store = new SkillFileStore(root, "user");
    const s = mkSkill({ name: "My Skill" });
    await store.save(s);
    const loaded = await store.listAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe(s.name);
    expect(loaded[0].scope).toBe("user");
    expect(loaded[0].content).toBe(s.content);
  });

  it("listAll returns empty array if skills dir does not exist", async () => {
    const store = new SkillFileStore(root, "project");
    const loaded = await store.listAll();
    expect(loaded).toEqual([]);
  });

  it("skips malformed SKILL.md files and keeps going", async () => {
    const store = new SkillFileStore(root, "project");
    await store.save(mkSkill({ name: "Good Skill" }));

    const badDir = path.join(root, "skills", "bad");
    await fs.mkdir(badDir, { recursive: true });
    await fs.writeFile(path.join(badDir, "SKILL.md"), "no frontmatter here");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loaded = await store.listAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe("Good Skill");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("delete removes the skill directory", async () => {
    const store = new SkillFileStore(root, "project");
    await store.save(mkSkill({ name: "Gone" }));
    expect(existsSync(path.join(root, "skills", "gone"))).toBe(true);
    await store.delete("gone");
    expect(existsSync(path.join(root, "skills", "gone"))).toBe(false);
  });

  it("get returns undefined for missing skill", async () => {
    const store = new SkillFileStore(root, "project");
    const res = await store.get("nope");
    expect(res).toBeUndefined();
  });

  it("updates SKILL.md through an atomic same-directory replacement", async () => {
    const store = new SkillFileStore(root, "project");
    await store.save(mkSkill({ name: "Atomic Skill", content: "before" }));
    await store.save(mkSkill({ name: "Atomic Skill", content: "after" }));

    const skillDir = path.join(root, "skills", "atomic-skill");
    expect(await fs.readdir(skillDir)).toEqual(["SKILL.md"]);
    expect((await store.get("atomic-skill"))?.content).toBe("after");
  });

  it("does not follow a symlink used as the scope root", async () => {
    const linkParent = await tmpDir();
    const outside = await tmpDir();
    const linkedRoot = path.join(linkParent, "scope");
    await fs.symlink(outside, linkedRoot, "dir");
    const store = new SkillFileStore(linkedRoot, "project");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await store.listAll()).toEqual([]);
    expect(await store.get("run-tests")).toBeUndefined();
    await expect(store.save(mkSkill())).rejects.toThrow(/symlink/i);
    await expect(store.delete("run-tests")).rejects.toThrow(/symlink/i);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("does not follow a symlink used as the skills directory", async () => {
    const outside = await tmpDir();
    const sentinel = path.join(outside, "sentinel.txt");
    await fs.writeFile(sentinel, "outside");
    await fs.symlink(outside, path.join(root, "skills"), "dir");
    const store = new SkillFileStore(root, "project");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await store.listAll()).toEqual([]);
    expect(await store.get("run-tests")).toBeUndefined();
    await expect(store.save(mkSkill())).rejects.toThrow(/symlink/i);
    await expect(store.delete("run-tests")).rejects.toThrow(/symlink/i);
    expect(await fs.readFile(sentinel, "utf-8")).toBe("outside");
    expect(await fs.readdir(outside)).toEqual(["sentinel.txt"]);
  });

  it("does not follow a symlink used as a skill slug directory", async () => {
    const outside = await tmpDir();
    const outsideFile = path.join(outside, "SKILL.md");
    const outsideContent = serializeSkillMarkdown(mkSkill());
    await fs.writeFile(outsideFile, outsideContent);
    await fs.mkdir(path.join(root, "skills"));
    await fs.symlink(outside, path.join(root, "skills", "run-tests"), "dir");
    const store = new SkillFileStore(root, "project");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await store.listAll()).toEqual([]);
    expect(await store.get("run-tests")).toBeUndefined();
    await expect(store.save(mkSkill())).rejects.toThrow(/symlink/i);
    await expect(store.delete("run-tests")).rejects.toThrow(/symlink/i);
    expect(await fs.readFile(outsideFile, "utf-8")).toBe(outsideContent);
  });

  it("does not follow a symlink used as SKILL.md", async () => {
    const outside = await tmpDir();
    const outsideFile = path.join(outside, "outside.md");
    const outsideContent = serializeSkillMarkdown(mkSkill());
    await fs.writeFile(outsideFile, outsideContent);
    const skillDir = path.join(root, "skills", "run-tests");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.symlink(outsideFile, path.join(skillDir, "SKILL.md"), "file");
    const store = new SkillFileStore(root, "project");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await store.listAll()).toEqual([]);
    expect(await store.get("run-tests")).toBeUndefined();
    await expect(store.save(mkSkill())).rejects.toThrow(/symlink/i);
    await expect(store.delete("run-tests")).rejects.toThrow(/symlink/i);
    expect(await fs.readFile(outsideFile, "utf-8")).toBe(outsideContent);
  });

  it("rejects traversal and non-canonical slug input", async () => {
    const store = new SkillFileStore(root, "project");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(store.get("../outside")).resolves.toBeUndefined();
    await expect(store.get("run-tests/../../outside")).resolves.toBeUndefined();
    await expect(
      store.get(path.join(root, "outside")),
    ).resolves.toBeUndefined();
    await expect(store.delete("../outside")).rejects.toThrow(
      /invalid skill slug/i,
    );
    await expect(store.delete("Run Tests")).rejects.toThrow(
      /invalid skill slug/i,
    );
    expect(await fs.readdir(root)).toEqual([]);
  });
});
