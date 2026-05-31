# Spec 20: Built-in Tools

**Status:** Implemented  
**Location:** `packages/core/src/builtin-tools/`

## Overview

Built-in工具直接内置在 `@walle-agent/core` 中，创建 Agent 时**默认自动注册**，无需额外安装或配置。

对齐 DeepAgents 的设计：Agent 创建即可使用文件系统、Shell、计划管理等能力。

## Tool 列表

| Tool | 分类 | Risk | 需要审批 | 说明 |
|------|------|------|----------|------|
| ls | filesystem | low | No | 列出目录内容 |
| read_file | filesystem | low | No | 读取文件（支持分页） |
| write_file | filesystem | medium | Yes | 写入/创建文件 |
| edit_file | filesystem | medium | Yes | 按字符串匹配替换文件内容 |
| glob | filesystem | low | No | glob 模式匹配文件 |
| grep | filesystem | low | No | 搜索文件文本 |
| bash | shell | high | Yes | 执行 shell 命令 |
| plan | planning | low | No | 创建/管理结构化执行计划 |
| write_todos | task | low | No | 任务列表管理 |

## 默认行为

```ts
// 默认：所有内置工具自动注册
const agent = await Agent.create({
  name: "Walle",
  model: new OpenAIProvider({ model: "gpt-4" }),
});

// 禁用全部内置工具
const agent = await Agent.create({
  name: "Walle",
  model: provider,
  useBuiltinTools: false,
});

// 排除特定工具
const agent = await Agent.create({
  name: "Walle",
  model: provider,
  useBuiltinTools: { excludeTools: ["bash"] },
});

// 只启用部分工具
const agent = await Agent.create({
  name: "Walle",
  model: provider,
  useBuiltinTools: { includeTools: ["read_file", "ls", "glob", "grep"] },
});
```

## AgentConfig 接口

```ts
interface BuiltinToolsConfig {
  excludeTools?: string[];
  includeTools?: string[];
}

interface AgentConfig {
  // ...
  useBuiltinTools?: boolean | BuiltinToolsConfig; // default: true
}
```

## 各工具详细参数

### ls

```ts
input: { path?: string; recursive?: boolean; detailed?: boolean }
output: { path: string; entries: Array<{ name, type, size?, modified? }> }
```

### read_file

```ts
input: { path: string; startLine?: number; endLine?: number }
output: { path, content, totalLines, readLines: { start, end } }
```

### write_file

```ts
input: { path: string; content: string }
output: { path, status: "success", bytesWritten }
```

### edit_file

```ts
input: { path: string; search: string; replace: string; global?: boolean }
output: { path, status: "success" }
```

### glob

```ts
input: { pattern: string; cwd?: string }
output: { pattern, cwd, matches: string[], count }
```

### grep

```ts
input: { pattern: string; file: string; ignoreCase?: boolean; regex?: boolean }
output: { pattern, filesSearched, filesMatched, results: [{ file, lines: [{ lineNumber, content }] }] }
```

### bash

```ts
input: { command: string; cwd?: string; timeout?: number }
output: { status, command, output/stdout/stderr, exitCode }
```

### plan

```ts
input: {
  action: "create" | "update" | "get" | "list" | "delete" | "update_step";
  planId?: string;
  title?: string;
  steps?: Array<{ content: string; status?: "pending"|"in_progress"|"completed"|"skipped" }>;
  stepId?: string;
  stepStatus?: "pending"|"in_progress"|"completed"|"skipped";
  stepContent?: string;
}

// Plan 结构
interface Plan {
  id: string;
  title: string;
  steps: PlanStep[];
  status: "active" | "completed" | "archived";
  createdAt: string;
  updatedAt: string;
}

interface PlanStep {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "skipped";
}
```

Plan 的 status 会自动更新：当所有 steps 为 completed/skipped 时，plan 自动标记为 completed。

### write_todos

```ts
input: { action: "add"|"list"|"complete"|"remove"|"clear"; task?: string; taskId?: string; listName?: string }
```

## 实现架构

```
packages/core/src/
├── builtin-tools/
│   ├── index.ts            # 汇总导出 + BUILTIN_TOOLS 数组
│   ├── filesystem-tools.ts # ls, read_file, write_file, edit_file, glob, grep
│   ├── shell-tool.ts       # bash
│   ├── plan-tool.ts        # plan
│   └── todo-tool.ts        # write_todos
├── agent-config.ts         # BuiltinToolsConfig + useBuiltinTools 选项
├── agent-runtime.ts        # init() 中自动注册 + registerBuiltinTools()
└── index.ts                # 公开导出所有内置工具
```

关键设计：
- 内置工具在 `AgentRuntime.init()` 中**先于**用户工具注册
- 用户通过 `tools: [...]` 传入的工具可以覆盖同名内置工具
- 不耦合：core 不依赖外部包，`glob` 是唯一额外依赖

## 测试

```bash
npx vitest run packages/core/tests/builtin-tools.test.ts
```

覆盖 37 个测试用例，包括：
- 每个工具的基本功能
- 边界情况（文件不存在、权限错误等）
- plan 工具的完整 CRUD + 自动状态更新
- BUILTIN_TOOLS 数组完整性

## 与 DeepAgents 对比

| 能力 | DeepAgents | Walle |
|------|-----------|-------|
| 文件系统工具 | ✓ (via FilesystemMiddleware) | ✓ (内置 core) |
| Shell 执行 | ✓ (execute) | ✓ (bash) |
| 任务管理 | ✓ (write_todos) | ✓ (write_todos) |
| 结构化计划 | ✗ | ✓ (plan) |
| 默认注册 | ✓ (middleware auto-applied) | ✓ (useBuiltinTools: true) |
| 选择性注册 | ✓ | ✓ (include/exclude) |
