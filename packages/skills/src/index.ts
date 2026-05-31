/**
 * @walle-agent/skills — public API.
 */

export { SkillsPlugin } from "./skills-plugin.js";
export { SkillRegistry } from "./skill-registry.js";
export { SkillFileStore } from "./skill-file-store.js";
export type { SkillStore } from "./skill-file-store.js";
export type { SkillRegistryStores } from "./skill-registry.js";
export type {
  Skill,
  SkillType,
  SkillScope,
  SkillTrigger,
  SkillMetadata,
  SkillsPluginConfig,
} from "./skill-types.js";
export {
  parseSkillMarkdown,
  serializeSkillMarkdown,
  slugify,
} from "./skill-markdown.js";
export { buildSkillTool } from "./skill-tool.js";
export type {
  SkillToolOutput,
  SkillToolSuccess,
  SkillToolError,
} from "./skill-tool.js";
