import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext, ContextItem, Tool } from "@walle-agent/core";
import { SkillsPlugin } from "../src/skills-plugin.js";
import { SkillFileStore } from "../src/skill-file-store.js";
import type { Skill } from "../src/skill-types.js";
import type { SkillToolError, SkillToolSuccess } from "../src/skill-tool.js";

async function tmpDir(prefix = "walle-skills-plugin-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function mkSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: overrides.id ?? `skill-${Math.random().toString(36).slice(2)}`,
    name: "Deploy To Vercel",
    description: "Deploy a Next.js app to Vercel",
    type: "prompt",
    content: "1. pnpm test\n2. pnpm build\n3. vercel --prod",
    tags: ["deploy"],
    trigger: { keywords: ["deploy", "vercel"] },
    metadata: {
      createdBy: "human",
      createdAt: new Date().toISOString(),
      usageCount: 0,
      successCount: 0,
      confidence: 0.9,
    },
    ...overrides,
  };
}

interface FakeCtx {
  ctx: AgentContext;
  tools: Map<string, Tool>;
  emitCollectContext: (query: string) => Promise<ContextItem[]>;
}

function fakeContext(): FakeCtx {
  const tools = new Map<string, Tool>();
  const listeners = new Map<string, Array<(payload: unknown) => unknown>>();

  const events = {
    on: (event: string, handler: (payload: unknown) => unknown) => {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
    },
  };

  const ctx = {
    agent: undefined,
    config: undefined,
    events,
    registerTool: (tool: Tool) => {
      tools.set(tool.name, tool);
    },
    registerHook: () => void 0,
    registerMiddleware: () => void 0,
    getPlugin: () => undefined,
  } as unknown as AgentContext;

  const emitCollectContext = async (query: string) => {
    const items: ContextItem[] = [];
    const handlers = listeners.get("collect_context") ?? [];
    for (const h of handlers) await h({ query, items });
    return items;
  };

  return { ctx, tools, emitCollectContext };
}

describe("SkillsPlugin", () => {
  let projectDir: string;
  let userDir: string;

  beforeEach(async () => {
    projectDir = await tmpDir("walle-skills-proj-");
    userDir = await tmpDir("walle-skills-user-");
  });

  it("registers the `skill` tool with a static description", async () => {
    const plugin = new SkillsPlugin({ project: projectDir, user: userDir });
    const { ctx, tools } = fakeContext();
    await plugin.install(ctx);

    const tool = tools.get("skill");
    expect(tool).toBeDefined();
    expect(tool!.description).toMatch(/Skills catalog/);
  });

  it("skill tool returns skill content on valid name, bumps usage count", async () => {
    const plugin = new SkillsPlugin({ project: projectDir, user: userDir });
    const { ctx, tools } = fakeContext();
    await plugin.install(ctx);
    await plugin.registry.register(mkSkill({ name: "Run Tests", content: "pnpm test" }));

    const tool = tools.get("skill")!;
    const ok = (await tool.execute({ name: "Run Tests" }, { agent: undefined as never })) as SkillToolSuccess;
    expect(ok.name).toBe("Run Tests");
    expect(ok.content).toBe("pnpm test");
    expect(ok.scope).toBe("project");

    // Slug form also works.
    const okSlug = (await tool.execute({ name: "run-tests" }, { agent: undefined as never })) as SkillToolSuccess;
    expect(okSlug.name).toBe("Run Tests");

    // Usage counters bumped.
    expect(plugin.registry.get("Run Tests")!.metadata.usageCount).toBe(2);
    expect(plugin.registry.get("Run Tests")!.metadata.lastUsedAt).toBeTruthy();
  });

  it("skill tool returns error object (no throw) on unknown name", async () => {
    const plugin = new SkillsPlugin({ project: projectDir, user: userDir });
    const { ctx, tools } = fakeContext();
    await plugin.install(ctx);
    await plugin.registry.register(mkSkill({ name: "Run Tests" }));

    const tool = tools.get("skill")!;
    const bad = (await tool.execute({ name: "missing" }, { agent: undefined as never })) as SkillToolError;
    expect(bad.error).toMatch(/not found/);
    expect(bad.available).toContain("run-tests");
  });

  it("merges project + user scopes with project precedence", async () => {
    await new SkillFileStore(userDir, "user").save(
      mkSkill({ id: "user-deploy", name: "Deploy To Vercel", description: "[user]" }),
    );
    await new SkillFileStore(userDir, "user").save(
      mkSkill({ id: "user-only", name: "Rollback Release", description: "user-only" }),
    );
    await new SkillFileStore(projectDir, "project").save(
      mkSkill({ id: "proj-deploy", name: "Deploy To Vercel", description: "[project]" }),
    );

    const plugin = new SkillsPlugin({ project: projectDir, user: userDir });
    const { ctx } = fakeContext();
    await plugin.install(ctx);

    expect(plugin.registry.list()).toHaveLength(2);
    const deploy = plugin.registry.get("Deploy To Vercel")!;
    expect(deploy.description).toBe("[project]");
    expect(deploy.scope).toBe("project");
    const rollback = plugin.registry.get("Rollback Release")!;
    expect(rollback.scope).toBe("user");
  });

  it("always injects a full Skills catalog on collect_context", async () => {
    const plugin = new SkillsPlugin({ project: projectDir, user: userDir });
    const { ctx, emitCollectContext } = fakeContext();
    await plugin.install(ctx);

    // Empty: no items pushed.
    expect(await emitCollectContext("anything")).toEqual([]);

    await plugin.registry.register(
      mkSkill({ name: "Deploy To Vercel", description: "Deploy a Next.js app to Vercel" }),
    );
    await plugin.registry.register(
      mkSkill({ name: "Run Tests", description: "Execute the project's test suite" }),
    );

    // Non-empty: one catalog item listing every skill, regardless of query.
    const items = await emitCollectContext("query is irrelevant");
    expect(items).toHaveLength(1);
    expect(items[0].source).toBe("skills");
    expect(items[0].metadata?.kind).toBe("catalog");
    expect(items[0].metadata?.count).toBe(2);
    expect(items[0].content).toMatch(/### Skills catalog/);
    expect(items[0].content).toMatch(/deploy-to-vercel.*Deploy a Next\.js app to Vercel/);
    expect(items[0].content).toMatch(/run-tests.*Execute the project's test suite/);
    // Body of the SOP must NOT be in the catalog — it's fetched via the tool.
    expect(items[0].content).not.toMatch(/pnpm test/);
  });

  it("exposes the registry via ctx.__skillRegistry for Evolution", async () => {
    const plugin = new SkillsPlugin({ project: projectDir, user: userDir });
    const { ctx } = fakeContext();
    await plugin.install(ctx);
    const exposed = (ctx as unknown as { __skillRegistry?: unknown }).__skillRegistry;
    expect(exposed).toBe(plugin.registry);
  });

  it("expands ~/ in user path using os.homedir()", async () => {
    const fakeHome = await tmpDir("walle-skills-home-");
    // `os.homedir()` honours process.env.HOME on POSIX and USERPROFILE on
    // Windows — easier + ESM-safe than spying on the namespaced export.
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    try {
      const plugin = new SkillsPlugin({ project: projectDir, user: "~/.agents" });
      expect(plugin.userStore.rootDir).toBe(path.resolve(fakeHome, ".agents"));
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserProfile;
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
