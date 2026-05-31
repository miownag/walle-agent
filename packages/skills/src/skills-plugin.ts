/**
 * SkillsPlugin — loads skills from disk (project + user scopes) and surfaces
 * them to the LLM in two ways:
 *
 *  1. Every turn, via `collect_context`, it injects the full **Skills
 *     catalog** (name + description for every loaded skill, no body) into
 *     the system prompt. Metadata is cheap; retrieval/ranking would cost
 *     more than it saves.
 *  2. The `skill` tool lets the LLM fetch a skill's full SOP body on demand.
 *
 * Layout (Claude Code-style):
 *   <project>/skills/<slug>/SKILL.md   (default project = ./.agents)
 *   <user>/skills/<slug>/SKILL.md      (default user    = ~/.agents)
 *
 * Project scope wins on slug collision. `register()` (called by Evolution)
 * always persists to the project store.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext, ContextItem, WallePlugin } from "@walle-agent/core";
import { SkillFileStore } from "./skill-file-store.js";
import { SkillRegistry } from "./skill-registry.js";
import { slugify } from "./skill-markdown.js";
import { buildSkillTool } from "./skill-tool.js";
import type { Skill, SkillsPluginConfig } from "./skill-types.js";

const DEFAULT_PROJECT_DIR = "./.agents";
const DEFAULT_USER_DIR = "~/.agents";

export class SkillsPlugin implements WallePlugin {
  readonly name = "skills";
  readonly version = "0.1.0";

  readonly registry: SkillRegistry;
  readonly projectStore: SkillFileStore;
  readonly userStore: SkillFileStore;

  constructor(private readonly config: SkillsPluginConfig = {}) {
    const projectPath = path.resolve(expandHome(config.project ?? DEFAULT_PROJECT_DIR));
    const userPath = path.resolve(expandHome(config.user ?? DEFAULT_USER_DIR));

    this.projectStore = new SkillFileStore(projectPath, "project");
    this.userStore = new SkillFileStore(userPath, "user");
    this.registry = new SkillRegistry({
      project: this.projectStore,
      user: this.userStore,
    });
  }

  async install(ctx: AgentContext): Promise<void> {
    // Register the tool first so it exists even if disk load fails.
    ctx.registerTool(buildSkillTool(this.registry));

    await this.registry.loadAll();

    // Always inject the full skills catalog on every turn. Metadata is cheap
    // and retrieval adds complexity without meaningful token savings.
    ctx.events.on("collect_context", async ({ items }) => {
      const skills = this.registry.list();
      if (skills.length === 0) return;
      items.push(this.toCatalogItem(skills));
    });

    // Expose the registry so EvolutionPlugin can register new skills without
    // importing this package directly.
    (ctx as unknown as { __skillRegistry?: SkillRegistry }).__skillRegistry = this.registry;
  }

  private toCatalogItem(skills: Skill[]): ContextItem {
    const lines = ["### Skills catalog", ""];
    lines.push(
      "The following skills are available. Call the `skill` tool with the slug (or name) to fetch the full instructions before following one.",
      "",
    );
    for (const skill of [...skills].sort((a, b) => a.name.localeCompare(b.name))) {
      const slug = slugify(skill.name);
      const scopeTag = skill.scope ? ` [${skill.scope}]` : "";
      lines.push(`- **${slug}**${scopeTag} — ${skill.description}`);
    }
    const content = lines.join("\n");
    return {
      source: "skills",
      // High priority so the catalog survives prompt trimming — it's small.
      priority: 85,
      content,
      estimatedTokens: Math.ceil(content.length / 4),
      metadata: { kind: "catalog", count: skills.length },
    };
  }
}

/** Expand a leading `~/` segment to the user's home directory. */
function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}
