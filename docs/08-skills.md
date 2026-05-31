# 08 — Skills

## 概念区分

| | Tool | Skill |
|---|------|-------|
| 本质 | 动作能力 | 可复用经验/流程/SOP |
| 来源 | 开发者定义 | 人工编写 或 Agent 自动沉淀 |
| 执行方式 | 直接执行函数 | 元数据全量注入 system prompt；LLM 按需通过 `skill` 工具取正文 |
| 触发方式 | LLM function calling | LLM 从 system prompt 的 skill 目录里挑一个，调用 `skill({ name })` |
| 生命周期 | 静态注册 | 可动态创建、进化、废弃；磁盘即真理 |

---

## Skill 分类

```ts
export type SkillType = "prompt" | "workflow" | "code";
```

### Prompt Skill
- 描述如何完成某类任务的 SOP
- 以 SKILL.md 落盘，`skill` 工具按需返回正文供 LLM 参考
- 不直接执行代码

### Workflow Skill
- 对多个工具调用的预编排（Phase-2 之后开放）
- 定义一个执行 pipeline
- 由 SkillExecutor 驱动

### Code Skill
- 可执行的 TypeScript 代码片段
- 由 Agent 自动生成或开发者手写
- 必须在 Sandbox 中执行

---

## 曝露模型：catalog + on-demand body

Skill 分两层信息：

1. **元信息（name + description）** —— 体量小、稳定，每轮都全量注入 system prompt。
   没必要为它做检索/打分，那会让 LLM 看不到它本来能胜任的技能，还增加实现复杂度。
2. **正文（SOP body）** —— 真正占 token 的部分，按需取。LLM 从 catalog 里挑一个 name，
   调 `skill({ name })` 工具拿回正文，再据此行事。

这是 Claude Code 的 Skills 机制沿用的套路，也是本系统的默认行为。

---

## 存储布局

仿 Claude Code 的 `.claude/skills/<name>/SKILL.md` 设计，两个 scope：

```
<project-root>/   (默认 ./.agents，通过 SkillsPlugin.project 配置)
└── skills/
    ├── deploy-nextjs/
    │   └── SKILL.md
    └── run-tests/
        └── SKILL.md

<user-root>/      (默认 ~/.agents，通过 SkillsPlugin.user 配置)
└── skills/
    └── my-personal-skill/
        └── SKILL.md
```

- **Project scope** 优先于 **User scope**：两者同名时 project 覆盖 user。
- **写入** 总是落到 project scope（`register`、`update` 均如此）。User scope 从 registry 视角只读；手动编辑 `~/.agents/skills/...` 当然可行。
- 目录名 = `slugify(skill.name)`（小写、非字母数字转 `-`，最长 64 字符）。

### SKILL.md 格式

YAML frontmatter + markdown 正文：

```md
---
id: skill-deploy-nextjs              # 可省略；首次加载时由 slug(name) 生成
name: Deploy Next.js to Vercel
description: Standard procedure for deploying a Next.js app to Vercel
type: prompt                          # prompt | workflow | code
tags: [deploy, nextjs, vercel]
version: 1.0
trigger:
  keywords: [deploy, vercel, nextjs]
  examples:
    - 帮我部署到 Vercel
    - How to deploy this app
createdBy: human                      # human | agent
createdAt: 2026-05-05T00:00:00Z
updatedAt: 2026-05-06T00:00:00Z
confidence: 0.9
usageCount: 0
successCount: 0
---
1. Ensure all tests pass: `pnpm test`
2. Build locally: `pnpm build`
3. Push to main branch or run `vercel --prod`
4. Verify deployment URL is accessible
```

`SkillMetadata` 的字段被拍平到 frontmatter 顶层（`createdBy`、`createdAt`、`updatedAt`、`usageCount`、`successCount`、`confidence`、`lastUsedAt`），便于人工编辑。Markdown 正文 = `skill.content`。

---

## Skill Interface

```ts
export type SkillScope = "project" | "user";

export interface Skill {
  id: string;
  name: string;
  description: string;

  type: SkillType;

  /** Prompt SOP 正文 / workflow YAML / code 源码。*/
  content: string;

  /** 标签 */
  tags?: string[];

  /** 版本号 */
  version?: string;

  /** 触发条件（info only；当前不参与 catalog 过滤）。*/
  trigger?: SkillTrigger;

  /** 元数据 */
  metadata: SkillMetadata;

  /**
   * 运行时字段：由 store 在加载时标记，表明该 skill 来自哪个 scope。
   * 不落盘。
   */
  scope?: SkillScope;
}

export interface SkillTrigger {
  keywords?: string[];
  examples?: string[];
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
```

---

## Skills Plugin

```ts
export interface SkillsPluginConfig {
  /** Project-scope 根目录。默认 "./.agents"。 */
  project?: string;
  /** User-scope 根目录。默认 "~/.agents"（自动展开 ~）。 */
  user?: string;
}
```

`install()` 流程：

1. 为 project / user 分别建立 `SkillFileStore`（user 为只读参与者）。
2. **先** 通过 `ctx.registerTool(buildSkillTool(registry))` 注册 `skill` 工具 —— 即便磁盘加载失败，工具也存在。
3. 调 `registry.loadAll()` 读盘并合并（user 先、project 后，后者覆盖前者）。
4. 订阅 `collect_context`：**每轮都** 把完整的 skill 目录（name + description）作为一条 ContextItem 注入 system prompt。内容不包含 SOP 正文。
5. 把 registry 暴露到 `ctx.__skillRegistry`，供 EvolutionPlugin 调用 `register()`。

### 注入到 system prompt 的 catalog 格式

```
### Skills catalog

The following skills are available. Call the `skill` tool with the slug (or
name) to fetch the full instructions before following one.

- **deploy-next-js-to-vercel** [project] — Standard procedure for deploying a Next.js app to Vercel
- **run-tests** [user] — Execute the project's test suite
```

零 skill 时不注入任何东西。`priority: 85`（不易被 prompt trimming 吃掉；反正体量小）。

---

## `skill` 工具

LLM 通过 `skill` 工具按需获取 SOP 正文：

```jsonc
// tool input
{ "name": "deploy-nextjs" }   // 名称或 slug 都接受

// tool output (success)
{
  "name": "Deploy Next.js to Vercel",
  "slug": "deploy-next-js-to-vercel",
  "description": "Standard procedure for deploying a Next.js app to Vercel",
  "content": "1. Ensure tests pass...\n2. Build locally...\n...",
  "tags": ["deploy", "nextjs", "vercel"],
  "scope": "project"
}

// tool output (unknown name)
{
  "error": "Skill not found: 'deploy-bun'",
  "available": ["deploy-next-js-to-vercel", "run-tests"]
}
```

关键点：
- 工具描述很短、静态 —— catalog 已经在 system prompt 里了，工具自己不需要再重复一遍。
- 成功调用会通过 `registry.markUsed(name)` 异步 bump `usageCount` / `lastUsedAt`。

---

## SkillRegistry

```ts
export class SkillRegistry {
  constructor(stores: { project: SkillStore; user?: SkillStore });

  /** 合并两个 scope（user 先、project 覆盖）到内存 Map<slug, Skill>。 */
  loadAll(): Promise<void>;

  /** 始终写入 project store；slug 冲突时覆盖 + console.warn。 */
  register(skill: Skill): Promise<void>;

  /** 接受名称或 slug。 */
  get(nameOrSlug: string): Skill | undefined;
  list(): Skill[];
  remove(nameOrSlug: string): Promise<void>;
  update(nameOrSlug: string, patch: Partial<Skill>): Promise<Skill | undefined>;

  /** 由 `skill` 工具在成功调用后调用。异步 bump usageCount / lastUsedAt。 */
  markUsed(nameOrSlug: string): void;
}
```

> **无 retrieve()**：早期版本做过关键词打分 + topK。去掉了。skill 元信息太小，不值得做检索，
> 检索还会让 LLM 看不到本来能用的技能。正文才是真正占 token 的部分，那个 on-demand 拿。

---

## SkillFileStore

```ts
export interface SkillStore {
  readonly scope: SkillScope;
  readonly rootDir: string;
  listAll(): Promise<Skill[]>;
  save(skill: Skill): Promise<void>;
  get(slug: string): Promise<Skill | undefined>;
  delete(slug: string): Promise<void>;
}

export class SkillFileStore implements SkillStore {
  constructor(rootDir: string, scope: SkillScope);
  // 读写 <rootDir>/skills/<slug>/SKILL.md，slug = slugify(skill.name)。
}
```

- `listAll()`：扫描 `<rootDir>/skills/` 下所有子目录，加载每个 `SKILL.md`；单文件解析失败时 `console.warn` 并跳过，不影响其他 skill。
- `save()`：`mkdir -p` 后写 `SKILL.md`（YAML frontmatter + 正文）。
- `delete()`：`rm -rf <rootDir>/skills/<slug>`。

---

## Skill 使用示例

### 1. 手动放一个 SKILL.md

```bash
mkdir -p ./.agents/skills/deploy-nextjs
cat > ./.agents/skills/deploy-nextjs/SKILL.md <<'EOF'
---
name: Deploy Next.js to Vercel
description: Standard procedure for deploying a Next.js app to Vercel
type: prompt
tags: [deploy, nextjs, vercel]
createdBy: human
createdAt: 2026-05-05T00:00:00Z
confidence: 0.9
usageCount: 0
successCount: 0
---
1. pnpm test
2. pnpm build
3. vercel --prod
EOF
```

下次启动 Agent，system prompt 里的 **Skills catalog** 就会列出 `deploy-next-js-to-vercel`。
LLM 通过 `skill({ name: "deploy-nextjs" })` 拿到正文。

### 2. 手动注册 Prompt Skill（代码路径）

```ts
import { SkillsPlugin } from "@walle-agent/skills";

const skills = new SkillsPlugin({
  project: "./.agents",
  user: "~/.agents",
});

// 在 install 之后：
await skills.registry.register({
  id: "skill-deploy-nextjs",
  name: "Deploy Next.js to Vercel",
  description: "Standard procedure for deploying a Next.js app to Vercel",
  type: "prompt",
  tags: ["deploy", "nextjs", "vercel"],
  trigger: {
    keywords: ["deploy", "vercel", "nextjs", "部署"],
    examples: ["帮我部署到 Vercel"],
  },
  content: `
1. pnpm test
2. pnpm build
3. vercel --prod
  `.trim(),
  metadata: {
    createdBy: "human",
    createdAt: new Date().toISOString(),
    usageCount: 0,
    successCount: 0,
    confidence: 0.9,
  },
});
// 自动落盘到 ./.agents/skills/deploy-next-js-to-vercel/SKILL.md
```

### 3. Agent 自进化沉淀

EvolutionPlugin 在 `taskReview` 触发后，如果评估出一个可复用的流程，会通过
`ctx.__skillRegistry.register(...)` 生成一条 skill。新 skill 直接落到 project
scope 的 SKILL.md，下一轮 system prompt 的 catalog 就会带上它。

---

## 迁移备忘（Phase-2 → Phase-2 revision）

| 旧 | 新 |
|---|---|
| `new SkillsPlugin({ storePath: "./.walle/skills" })` | `new SkillsPlugin({ project: "./.agents", user: "~/.agents" })` |
| 单一 scope，`./.walle/skills/<id>.json` | 双 scope，`<scope>/skills/<slug>/SKILL.md` |
| `collect_context` 用 retrieve() 做关键词检索选 topK | catalog 全量注入 system prompt；正文按需通过 `skill` 工具取 |
| `SkillsPluginConfig.injectContext / maxSkillsPerQuery / minScore` | 已移除；行为固定为"元信息全注入" |
| `SkillRegistry.retrieve()` | 已移除；用 `list()` 自取 |
| `SkillFileStore(dir)` | `new SkillFileStore(rootDir, scope)` |
