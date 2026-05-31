/**
 * Skill types — reusable procedures surfaced to the LLM via a `skill` tool.
 *
 * Storage format: `<scope-root>/skills/<slug>/SKILL.md` with YAML frontmatter
 * + markdown body (Claude Code-style). Mirrors `docs/08-skills.md`.
 * Phase-2 scope covers Prompt Skills only; workflow/code types reserved.
 *
 * Surfacing: all registered skills' metadata (name + description) is injected
 * into the system prompt on every turn via `collect_context`. Skill bodies
 * (the SOP itself) are fetched on demand by the LLM via the `skill` tool.
 * Metadata is cheap enough that retrieval/ranking would cost more than it
 * saves; the whole catalog goes in.
 */

export type SkillType = "prompt" | "workflow" | "code";
export type SkillScope = "project" | "user";

export interface SkillTrigger {
  /** Keyword match (fast, cheap). Informational only; not used for filtering. */
  keywords?: string[];
  /** Example queries that should trigger this skill. Shown to the LLM. */
  examples?: string[];
  /** Reserved: embedding vector for future semantic surfacing. */
  embedding?: number[];
}

export interface SkillMetadata {
  createdBy: "human" | "agent";
  createdAt: string;
  updatedAt?: string;
  usageCount: number;
  successCount: number;
  /** 0..1 confidence for the skill's quality. */
  confidence: number;
  lastUsedAt?: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  type: SkillType;
  /** Prompt SOP text / workflow YAML / code source. */
  content: string;
  tags?: string[];
  version?: string;
  trigger?: SkillTrigger;
  metadata: SkillMetadata;
  /**
   * Which scope this skill was loaded from. Not persisted to disk — the store
   * stamps it on every load so callers (e.g. the `skill` tool) can surface it.
   */
  scope?: SkillScope;
}

export interface SkillsPluginConfig {
  /**
   * Project-scope root directory. Default: `./.agents`.
   * Skills are read/written at `<project>/skills/<slug>/SKILL.md`.
   */
  project?: string;
  /**
   * User-scope root directory. Default: `~/.agents` (tilde expanded).
   * Skills are read-only at `<user>/skills/<slug>/SKILL.md`; project skills
   * with the same slug take precedence.
   */
  user?: string;
}
