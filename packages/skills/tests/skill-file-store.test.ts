import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { SkillFileStore } from "../src/skill-file-store.js";
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
});
