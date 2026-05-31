/**
 * SkillFileStore — one instance per scope, persists skills as
 * `<scopeRoot>/skills/<slug>/SKILL.md` (YAML frontmatter + markdown body).
 *
 * Reads never throw: malformed files are logged and skipped so one bad skill
 * doesn't take down the whole scope. Writes always create the skill
 * subdirectory on demand.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { existsSync } from "node:fs";
import type { Skill, SkillScope } from "./skill-types.js";
import {
  parseSkillMarkdown,
  serializeSkillMarkdown,
  slugify,
} from "./skill-markdown.js";

export interface SkillStore {
  readonly scope: SkillScope;
  readonly rootDir: string;
  listAll(): Promise<Skill[]>;
  save(skill: Skill): Promise<void>;
  get(slug: string): Promise<Skill | undefined>;
  delete(slug: string): Promise<void>;
}

export class SkillFileStore implements SkillStore {
  readonly scope: SkillScope;
  /** Scope root (e.g. `./.agents`). Skills live under `<rootDir>/skills/...`. */
  readonly rootDir: string;
  /** Full path to the `skills/` subdirectory for this scope. */
  readonly skillsDir: string;

  constructor(rootDir: string, scope: SkillScope) {
    this.rootDir = rootDir;
    this.scope = scope;
    this.skillsDir = path.join(rootDir, "skills");
  }

  async listAll(): Promise<Skill[]> {
    if (!existsSync(this.skillsDir)) return [];
    const entries = await fs.readdir(this.skillsDir, { withFileTypes: true });
    const skills: Skill[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const filePath = path.join(this.skillsDir, entry.name, "SKILL.md");
      if (!existsSync(filePath)) continue;
      try {
        const raw = await fs.readFile(filePath, "utf-8");
        const skill = parseSkillMarkdown(raw);
        skill.scope = this.scope;
        skills.push(skill);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[skills] failed to parse ${filePath}:`, (err as Error).message);
      }
    }
    return skills;
  }

  async save(skill: Skill): Promise<void> {
    const slug = slugify(skill.name);
    const dir = path.join(this.skillsDir, slug);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "SKILL.md");
    const content = serializeSkillMarkdown(skill);
    await fs.writeFile(filePath, content, "utf-8");
  }

  async get(slug: string): Promise<Skill | undefined> {
    const filePath = path.join(this.skillsDir, slug, "SKILL.md");
    if (!existsSync(filePath)) return undefined;
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const skill = parseSkillMarkdown(raw);
      skill.scope = this.scope;
      return skill;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[skills] failed to parse ${filePath}:`, (err as Error).message);
      return undefined;
    }
  }

  async delete(slug: string): Promise<void> {
    const dir = path.join(this.skillsDir, slug);
    await fs.rm(dir, { recursive: true, force: true });
  }
}
