/**
 * `skill` tool — the LLM-facing surface for skill bodies.
 *
 * The full catalog of skills (name + description) is injected into the system
 * prompt on every turn by `SkillsPlugin` (see `skills-plugin.ts`), so this
 * tool's description stays short. The LLM picks a skill from that catalog and
 * calls `skill({ name })` to retrieve its SOP.
 */

import type { Tool } from "@walle-agent/core";
import type { SkillRegistry } from "./skill-registry.js";
import { slugify } from "./skill-markdown.js";

const DESCRIPTION =
  "Retrieve the full instructions (SOP) for a skill by name. The list of available skills is provided in the system prompt under 'Skills catalog'. Call this tool to fetch the body of a skill before following it; prefer invoking a known skill over improvising its steps.";

export interface SkillToolSuccess {
  name: string;
  slug: string;
  description: string;
  content: string;
  tags?: string[];
  scope?: string;
}

export interface SkillToolError {
  error: string;
  available: string[];
}

export type SkillToolOutput = SkillToolSuccess | SkillToolError;

export function buildSkillTool(registry: SkillRegistry): Tool<{ name: string }, SkillToolOutput> {
  return {
    name: "skill",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "The skill name or slug (e.g. 'deploy-nextjs'). Must match an entry from the Skills catalog in the system prompt.",
        },
      },
      required: ["name"],
    },
    riskLevel: "low",
    tags: ["builtin", "skills"],
    async execute(input) {
      const skill = registry.get(input.name);
      if (!skill) {
        return {
          error: `Skill not found: '${input.name}'`,
          available: registry.list().map((s) => slugify(s.name)),
        };
      }
      registry.markUsed(skill.name);
      return {
        name: skill.name,
        slug: slugify(skill.name),
        description: skill.description,
        content: skill.content,
        tags: skill.tags,
        scope: skill.scope,
      };
    },
  };
}
