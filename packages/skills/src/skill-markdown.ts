/**
 * SKILL.md <-> Skill marshalling.
 *
 * Layout:
 *
 *   ---
 *   id: skill-abc
 *   name: Deploy Next.js to Vercel
 *   description: Standard procedure for deploying a Next.js app to Vercel
 *   type: prompt
 *   tags: [deploy, vercel]
 *   trigger:
 *     keywords: [deploy, vercel]
 *     examples:
 *       - 帮我部署到 Vercel
 *   createdBy: human
 *   createdAt: 2026-05-06T00:00:00Z
 *   updatedAt: 2026-05-06T01:00:00Z
 *   confidence: 0.9
 *   usageCount: 0
 *   successCount: 0
 *   ---
 *   1. pnpm test
 *   2. pnpm build
 *   3. vercel --prod
 *
 * The metadata block is flattened to top-level frontmatter keys (createdBy,
 * createdAt, updatedAt, usageCount, successCount, confidence, lastUsedAt) so
 * the file is pleasant to hand-edit. Unrecognised keys are preserved as-is
 * under `extra` so round-tripping is lossless in practice.
 */

import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import type { Skill, SkillMetadata, SkillTrigger, SkillType } from "./skill-types.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const METADATA_KEYS = [
  "createdBy",
  "createdAt",
  "updatedAt",
  "usageCount",
  "successCount",
  "confidence",
  "lastUsedAt",
] as const satisfies readonly (keyof SkillMetadata)[];

/** Convert a human name into a slug suitable for directory/tool-argument use. */
export function slugify(name: string): string {
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  const truncated = base.slice(0, 64).replace(/-+$/g, "");
  return truncated || "skill";
}

/**
 * Parse a SKILL.md string. Throws on malformed frontmatter; stores callers
 * should catch and skip so one bad file doesn't take down the whole scope.
 *
 * If `id` is missing, one is synthesised from the slug of `name`.
 */
export function parseSkillMarkdown(raw: string): Skill {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    throw new Error("SKILL.md must start with YAML frontmatter delimited by '---'");
  }
  const [, fmRaw, bodyRaw] = match;
  const fm = (yamlParse(fmRaw) ?? {}) as Record<string, unknown>;

  const name = stringField(fm, "name");
  const description = stringField(fm, "description");
  if (!name) throw new Error("SKILL.md frontmatter is missing required field `name`");
  if (!description)
    throw new Error("SKILL.md frontmatter is missing required field `description`");

  const type = (fm.type as SkillType | undefined) ?? "prompt";
  const id = stringField(fm, "id") || `skill-${slugify(name)}`;
  const tags = arrayField<string>(fm, "tags");
  const version = stringField(fm, "version");
  const trigger = parseTrigger(fm.trigger);

  const metadata: SkillMetadata = {
    createdBy:
      fm.createdBy === "agent" ? "agent" : "human",
    createdAt: stringField(fm, "createdAt") || new Date().toISOString(),
    updatedAt: stringField(fm, "updatedAt") || undefined,
    usageCount: numberField(fm, "usageCount") ?? 0,
    successCount: numberField(fm, "successCount") ?? 0,
    confidence: clamp01(numberField(fm, "confidence") ?? 0.5),
    lastUsedAt: stringField(fm, "lastUsedAt") || undefined,
  };

  return {
    id,
    name,
    description,
    type,
    content: bodyRaw.replace(/^\s+|\s+$/g, ""),
    tags,
    version: version || undefined,
    trigger,
    metadata,
  };
}

/**
 * Serialise a Skill into SKILL.md form. Keys appear in a stable, documented
 * order so edits produce minimal diffs.
 */
export function serializeSkillMarkdown(skill: Skill): string {
  const fm: Record<string, unknown> = {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    type: skill.type,
  };
  if (skill.tags && skill.tags.length > 0) fm.tags = skill.tags;
  if (skill.version) fm.version = skill.version;
  if (skill.trigger && hasTriggerContent(skill.trigger)) {
    fm.trigger = compactTrigger(skill.trigger);
  }
  for (const key of METADATA_KEYS) {
    const value = skill.metadata[key];
    if (value !== undefined) fm[key] = value;
  }

  const fmText = yamlStringify(fm, { lineWidth: 0 }).trimEnd();
  const body = skill.content.replace(/^\s+|\s+$/g, "");
  return `---\n${fmText}\n---\n${body}\n`;
}

// ─── Helpers ────────────────────────────────────────────────────────

function parseTrigger(raw: unknown): SkillTrigger | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const trigger: SkillTrigger = {};
  const keywords = arrayField<string>(obj, "keywords");
  const examples = arrayField<string>(obj, "examples");
  const embedding = arrayField<number>(obj, "embedding");
  if (keywords) trigger.keywords = keywords;
  if (examples) trigger.examples = examples;
  if (embedding) trigger.embedding = embedding;
  return hasTriggerContent(trigger) ? trigger : undefined;
}

function hasTriggerContent(t: SkillTrigger): boolean {
  return Boolean(
    (t.keywords && t.keywords.length) ||
      (t.examples && t.examples.length) ||
      (t.embedding && t.embedding.length),
  );
}

function compactTrigger(t: SkillTrigger): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (t.keywords && t.keywords.length) out.keywords = t.keywords;
  if (t.examples && t.examples.length) out.examples = t.examples;
  if (t.embedding && t.embedding.length) out.embedding = t.embedding;
  return out;
}

function stringField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === "string" ? v : "";
}

function numberField(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function arrayField<T>(obj: Record<string, unknown>, key: string): T[] | undefined {
  const v = obj[key];
  if (!Array.isArray(v)) return undefined;
  return v as T[];
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
