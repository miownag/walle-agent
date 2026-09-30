/**
 * SkillFileStore — one instance per scope, persists skills as
 * `<scopeRoot>/skills/<slug>/SKILL.md` (YAML frontmatter + markdown body).
 *
 * Reads never follow symbolic links: malformed or unsafe entries are logged
 * and skipped so one bad skill doesn't take down the whole scope. Writes and
 * deletes reject unsafe paths, and writes replace SKILL.md atomically.
 */

import { randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Skill, SkillScope } from "./skill-types.js";
import {
  parseSkillMarkdown,
  serializeSkillMarkdown,
  slugify,
} from "./skill-markdown.js";

const SKILLS_DIRECTORY = "skills";
const SKILL_FILE = "SKILL.md";

export interface SkillStore {
  readonly scope: SkillScope;
  readonly rootDir: string;
  listAll(): Promise<Skill[]>;
  save(skill: Skill): Promise<void>;
  get(slug: string): Promise<Skill | undefined>;
  delete(slug: string): Promise<void>;
}

/** Raised when a mutating operation encounters an unsafe store path. */
export class SkillStorePathError extends Error {
  override readonly name = "SkillStorePathError";
}

interface ResolvedScope {
  /** Canonical scope root used as the outer filesystem boundary. */
  root: string;
  /** Canonical `<scopeRoot>/skills` directory. */
  skills: string;
}

export class SkillFileStore implements SkillStore {
  readonly scope: SkillScope;
  /** Absolute scope root (e.g. `./.agents`). */
  readonly rootDir: string;
  /** Absolute path to the `skills/` subdirectory for this scope. */
  readonly skillsDir: string;

  constructor(rootDir: string, scope: SkillScope) {
    this.rootDir = path.resolve(rootDir);
    this.scope = scope;
    this.skillsDir = path.join(this.rootDir, SKILLS_DIRECTORY);
  }

  async listAll(): Promise<Skill[]> {
    let resolved: ResolvedScope | undefined;
    try {
      resolved = await this.resolveScope(false);
    } catch (error) {
      warnUnsafe(this.skillsDir, error);
      return [];
    }
    if (!resolved) return [];

    let entries: Dirent<string>[];
    try {
      entries = await fs.readdir(resolved.skills, { withFileTypes: true });
    } catch (error) {
      warnUnsafe(resolved.skills, error);
      return [];
    }

    const skills: Skill[] = [];
    for (const entry of entries) {
      const displayPath = path.join(this.skillsDir, entry.name, SKILL_FILE);
      try {
        assertCanonicalSlug(entry.name);
        const skillDir = await this.resolveSkillDirectory(
          resolved,
          entry.name,
          false,
        );
        if (!skillDir) continue;
        const filePath = await resolveRegularFile(resolved, skillDir);
        if (!filePath) continue;

        const raw = await readSkillFile(resolved, skillDir, filePath);
        const skill = parseSkillMarkdown(raw);
        skill.scope = this.scope;
        skills.push(skill);
      } catch (error) {
        warnUnsafe(displayPath, error);
      }
    }
    return skills;
  }

  async save(skill: Skill): Promise<void> {
    const slug = slugify(skill.name);
    assertCanonicalSlug(slug);

    const resolved = await this.resolveScope(true);
    if (!resolved) {
      throw new SkillStorePathError(
        `Unable to create skill scope "${this.rootDir}"`,
      );
    }
    const skillDir = await this.resolveSkillDirectory(resolved, slug, true);
    if (!skillDir) {
      throw new SkillStorePathError(
        `Unable to create directory for skill "${slug}"`,
      );
    }

    const filePath = path.join(skillDir, SKILL_FILE);
    await assertWritableSkillFile(resolved, skillDir, filePath);
    await atomicWriteSkillFile(
      resolved,
      skillDir,
      filePath,
      serializeSkillMarkdown(skill),
    );
  }

  async get(slug: string): Promise<Skill | undefined> {
    try {
      assertCanonicalSlug(slug);
      const resolved = await this.resolveScope(false);
      if (!resolved) return undefined;
      const skillDir = await this.resolveSkillDirectory(resolved, slug, false);
      if (!skillDir) return undefined;
      const filePath = await resolveRegularFile(resolved, skillDir);
      if (!filePath) return undefined;

      const raw = await readSkillFile(resolved, skillDir, filePath);
      const skill = parseSkillMarkdown(raw);
      skill.scope = this.scope;
      return skill;
    } catch (error) {
      // Invalid slugs and unsafe entries are indistinguishable from a missing
      // skill to callers. This keeps reads non-throwing without following them.
      warnUnsafe(
        path.join(this.skillsDir, safeDisplaySegment(slug), SKILL_FILE),
        error,
      );
      return undefined;
    }
  }

  async delete(slug: string): Promise<void> {
    assertCanonicalSlug(slug);
    const resolved = await this.resolveScope(false);
    if (!resolved) return;
    const skillDir = await this.resolveSkillDirectory(resolved, slug, false);
    if (!skillDir) return;

    // Deletion must reject a malicious SKILL.md symlink even though Node's rm
    // currently unlinks (rather than traverses) file symlinks. Keeping the
    // explicit invariant avoids depending on that implementation detail.
    const filePath = path.join(skillDir, SKILL_FILE);
    const fileStat = await lstatIfExists(filePath);
    if (fileStat?.isSymbolicLink()) {
      throw new SkillStorePathError(`Refusing to delete symlink "${filePath}"`);
    }
    if (fileStat && !fileStat.isFile()) {
      throw new SkillStorePathError(`Expected a regular file at "${filePath}"`);
    }
    if (fileStat) {
      await assertRealPathWithin(resolved.root, filePath, "skill scope");
      await assertRealPathWithin(skillDir, filePath, "skill directory");
    }

    // Revalidate the directory immediately before the recursive removal.
    await assertDirectoryWithin(resolved, skillDir, resolved.skills);
    await fs.rm(skillDir, { recursive: true, force: true });
  }

  /** Resolve/create the trusted root and skills directories without links. */
  private async resolveScope(
    create: boolean,
  ): Promise<ResolvedScope | undefined> {
    let rootStat = await lstatIfExists(this.rootDir);
    if (!rootStat && create) {
      await fs.mkdir(this.rootDir, { recursive: true });
      rootStat = await fs.lstat(this.rootDir);
    }
    if (!rootStat) return undefined;
    assertDirectoryNotSymlink(this.rootDir, rootStat);
    const canonicalRoot = await fs.realpath(this.rootDir);

    let skillsStat = await lstatIfExists(this.skillsDir);
    if (!skillsStat && create) {
      // The root is known to exist, so a non-recursive mkdir cannot silently
      // create through an unexpected child component.
      try {
        await fs.mkdir(this.skillsDir);
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) throw error;
      }
      skillsStat = await fs.lstat(this.skillsDir);
    }
    if (!skillsStat) return undefined;
    assertDirectoryNotSymlink(this.skillsDir, skillsStat);

    const canonicalSkills = await fs.realpath(this.skillsDir);
    assertWithin(canonicalRoot, canonicalSkills, "skill scope");
    return { root: canonicalRoot, skills: canonicalSkills };
  }

  /** Resolve/create one canonical slug directory without following links. */
  private async resolveSkillDirectory(
    resolved: ResolvedScope,
    slug: string,
    create: boolean,
  ): Promise<string | undefined> {
    assertCanonicalSlug(slug);
    const directory = path.join(resolved.skills, slug);
    assertWithin(resolved.skills, directory, "skills directory");

    let stat = await lstatIfExists(directory);
    if (!stat && create) {
      try {
        await fs.mkdir(directory);
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) throw error;
      }
      stat = await fs.lstat(directory);
    }
    if (!stat) return undefined;
    assertDirectoryNotSymlink(directory, stat);

    const canonicalDirectory = await fs.realpath(directory);
    assertWithin(resolved.root, canonicalDirectory, "skill scope");
    assertWithin(resolved.skills, canonicalDirectory, "skills directory");
    return canonicalDirectory;
  }
}

async function atomicWriteSkillFile(
  resolved: ResolvedScope,
  skillDir: string,
  filePath: string,
  content: string,
): Promise<void> {
  const temporaryPath = path.join(
    skillDir,
    `.${SKILL_FILE}.${process.pid}.${randomUUID()}.tmp`,
  );
  assertWithin(skillDir, temporaryPath, "skill directory");

  const noFollow =
    typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const flags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow;
  let handle: fs.FileHandle | undefined;
  let renamed = false;

  try {
    handle = await fs.open(temporaryPath, flags, 0o600);
    await handle.writeFile(content, "utf-8");
    await handle.sync();
    await handle.close();
    handle = undefined;

    const temporaryStat = await fs.lstat(temporaryPath);
    if (temporaryStat.isSymbolicLink() || !temporaryStat.isFile()) {
      throw new SkillStorePathError(
        `Atomic skill temporary path is not a regular file: "${temporaryPath}"`,
      );
    }
    await assertRealPathWithin(resolved.root, temporaryPath, "skill scope");
    await assertRealPathWithin(skillDir, temporaryPath, "skill directory");

    // Revalidate all mutable path components and the destination as close to
    // rename as the path-based Node filesystem API permits.
    await assertDirectoryWithin(resolved, skillDir, resolved.skills);
    await assertWritableSkillFile(resolved, skillDir, filePath);
    await fs.rename(temporaryPath, filePath);
    renamed = true;

    const written = await fs.lstat(filePath);
    if (written.isSymbolicLink() || !written.isFile()) {
      throw new SkillStorePathError(
        `Atomic write produced an unsafe file at "${filePath}"`,
      );
    }
    await assertRealPathWithin(resolved.root, filePath, "skill scope");
    await assertRealPathWithin(skillDir, filePath, "skill directory");
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    if (!renamed) await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

async function resolveRegularFile(
  resolved: ResolvedScope,
  skillDir: string,
): Promise<string | undefined> {
  const filePath = path.join(skillDir, SKILL_FILE);
  const stat = await lstatIfExists(filePath);
  if (!stat) return undefined;
  if (stat.isSymbolicLink()) {
    throw new SkillStorePathError(`Refusing to follow symlink "${filePath}"`);
  }
  if (!stat.isFile()) {
    throw new SkillStorePathError(`Expected a regular file at "${filePath}"`);
  }

  const canonicalFile = await fs.realpath(filePath);
  assertWithin(resolved.root, canonicalFile, "skill scope");
  assertWithin(skillDir, canonicalFile, "skill directory");
  return canonicalFile;
}

async function readSkillFile(
  resolved: ResolvedScope,
  skillDir: string,
  filePath: string,
): Promise<string> {
  const noFollow =
    typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await fs.open(filePath, constants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new SkillStorePathError(`Expected a regular file at "${filePath}"`);
    }
    // Re-check the pathname after opening and before consuming bytes. O_NOFOLLOW
    // protects the final component; these checks also cover its directory chain.
    await assertRealPathWithin(resolved.root, filePath, "skill scope");
    await assertRealPathWithin(skillDir, filePath, "skill directory");
    return await handle.readFile("utf-8");
  } finally {
    await handle.close();
  }
}

async function assertWritableSkillFile(
  resolved: ResolvedScope,
  skillDir: string,
  filePath: string,
): Promise<void> {
  assertWithin(skillDir, filePath, "skill directory");
  const stat = await lstatIfExists(filePath);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    throw new SkillStorePathError(`Refusing to replace symlink "${filePath}"`);
  }
  if (!stat.isFile()) {
    throw new SkillStorePathError(`Expected a regular file at "${filePath}"`);
  }
  await assertRealPathWithin(resolved.root, filePath, "skill scope");
  await assertRealPathWithin(skillDir, filePath, "skill directory");
}

async function assertDirectoryWithin(
  resolved: ResolvedScope,
  directory: string,
  parentBoundary: string,
): Promise<void> {
  const stat = await fs.lstat(directory);
  assertDirectoryNotSymlink(directory, stat);
  const canonicalDirectory = await fs.realpath(directory);
  assertWithin(resolved.root, canonicalDirectory, "skill scope");
  assertWithin(parentBoundary, canonicalDirectory, "skills directory");
}

async function assertRealPathWithin(
  boundary: string,
  candidate: string,
  label: string,
): Promise<void> {
  const canonicalCandidate = await fs.realpath(candidate);
  assertWithin(boundary, canonicalCandidate, label);
}

function assertDirectoryNotSymlink(
  candidate: string,
  stat: Awaited<ReturnType<typeof fs.lstat>>,
): void {
  if (stat.isSymbolicLink()) {
    throw new SkillStorePathError(`Refusing to follow symlink "${candidate}"`);
  }
  if (!stat.isDirectory()) {
    throw new SkillStorePathError(`Expected a directory at "${candidate}"`);
  }
}

function assertCanonicalSlug(slug: string): void {
  if (
    !slug ||
    slug.includes("\0") ||
    path.isAbsolute(slug) ||
    slug.split(/[\\/]+/u).some((segment) => segment === "..") ||
    slug !== slugify(slug)
  ) {
    throw new SkillStorePathError(
      `Invalid skill slug: "${safeDisplaySegment(slug)}"`,
    );
  }
}

function assertWithin(
  boundary: string,
  candidate: string,
  label: string,
): void {
  const relative = path.relative(boundary, candidate);
  if (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  ) {
    return;
  }
  throw new SkillStorePathError(
    `Path "${candidate}" escapes ${label} "${boundary}"`,
  );
}

async function lstatIfExists(
  candidate: string,
): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  try {
    return await fs.lstat(candidate);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function safeDisplaySegment(value: string): string {
  return value
    .replaceAll("\0", "\\0")
    .replaceAll("/", "∕")
    .replaceAll("\\", "⧵");
}

function warnUnsafe(filePath: string, error: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(
    `[skills] failed to load ${filePath}:`,
    error instanceof Error ? error.message : String(error),
  );
}
