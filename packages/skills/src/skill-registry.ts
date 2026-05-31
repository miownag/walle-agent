/**
 * SkillRegistry — in-memory index keyed by slug, backed by two scoped stores:
 * `project` (read/write) and `user` (read-only from the registry's POV).
 *
 * On `loadAll()`, user-scope skills are loaded first, then project-scope skills
 * overwrite them — project wins on slug collision. `register()` always persists
 * to the project store so Evolution-generated skills stay with the project.
 *
 * Retrieval is intentionally absent: skill metadata (name + description) is
 * cheap and always injected in full; skill bodies are fetched on demand via
 * the `skill` tool.
 */

import type { Skill } from "./skill-types.js";
import type { SkillStore } from "./skill-file-store.js";
import { slugify } from "./skill-markdown.js";

export interface SkillRegistryStores {
  project: SkillStore;
  user?: SkillStore;
}

export class SkillRegistry {
  /** Map key is `slug(skill.name)` — the same identifier used by the `skill` tool. */
  private skills = new Map<string, Skill>();
  private loaded = false;

  constructor(private readonly stores: SkillRegistryStores) {}

  /** The project-scope store — always writable. */
  get projectStore(): SkillStore {
    return this.stores.project;
  }

  /** The user-scope store, if configured. */
  get userStore(): SkillStore | undefined {
    return this.stores.user;
  }

  async loadAll(): Promise<void> {
    if (this.loaded) return;
    this.skills.clear();

    // User scope first so project skills can override on slug collision.
    if (this.stores.user) {
      const userSkills = await this.stores.user.listAll();
      for (const skill of userSkills) {
        const slug = slugify(skill.name);
        this.skills.set(slug, skill);
      }
    }

    const projectSkills = await this.stores.project.listAll();
    for (const skill of projectSkills) {
      const slug = slugify(skill.name);
      this.skills.set(slug, skill);
    }

    this.loaded = true;
  }

  /**
   * Register a skill and persist it to the **project** store. On slug collision
   * the existing entry is overwritten + a warning is logged — this matches
   * Phase-2 scope (pragmatic over strict).
   */
  async register(skill: Skill): Promise<void> {
    const slug = slugify(skill.name);
    const existing = this.skills.get(slug);
    if (existing) {
      // eslint-disable-next-line no-console
      console.warn(
        `[skills] slug collision on '${slug}' — overwriting existing skill '${existing.name}' (id=${existing.id}) with '${skill.name}' (id=${skill.id})`,
      );
    }
    const stamped: Skill = { ...skill, scope: "project" };
    this.skills.set(slug, stamped);
    await this.stores.project.save(stamped);
  }

  /** Resolve a lookup key, accepting either the raw name or the slug. */
  get(nameOrSlug: string): Skill | undefined {
    const direct = this.skills.get(nameOrSlug);
    if (direct) return direct;
    return this.skills.get(slugify(nameOrSlug));
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }

  /** Remove from both stores (defensive) and the in-memory map. */
  async remove(nameOrSlug: string): Promise<void> {
    const slug = this.skills.has(nameOrSlug) ? nameOrSlug : slugify(nameOrSlug);
    this.skills.delete(slug);
    await this.stores.project.delete(slug);
    if (this.stores.user) await this.stores.user.delete(slug);
  }

  /**
   * Patch a skill in place. If the existing skill is user-scope, materialise
   * a project-scope copy — project always wins for mutations.
   */
  async update(nameOrSlug: string, patch: Partial<Skill>): Promise<Skill | undefined> {
    const slug = this.skills.has(nameOrSlug) ? nameOrSlug : slugify(nameOrSlug);
    const existing = this.skills.get(slug);
    if (!existing) return undefined;
    const updated: Skill = {
      ...existing,
      ...patch,
      id: existing.id,
      metadata: {
        ...existing.metadata,
        ...(patch.metadata ?? {}),
        updatedAt: new Date().toISOString(),
      },
      scope: "project",
    };
    this.skills.set(slug, updated);
    await this.stores.project.save(updated);
    return updated;
  }

  /**
   * Mark a skill as used — bumps `usageCount` and `lastUsedAt`. Called by
   * the `skill` tool on every successful invocation. Persists in the
   * background; never blocks the tool call.
   */
  markUsed(nameOrSlug: string): void {
    const slug = this.skills.has(nameOrSlug) ? nameOrSlug : slugify(nameOrSlug);
    const skill = this.skills.get(slug);
    if (!skill) return;
    skill.metadata.usageCount += 1;
    skill.metadata.lastUsedAt = new Date().toISOString();
    // Persist on the skill's home scope without blocking.
    const targetStore =
      skill.scope === "user" ? this.stores.user : this.stores.project;
    if (targetStore) void targetStore.save(skill).catch(() => void 0);
  }
}
