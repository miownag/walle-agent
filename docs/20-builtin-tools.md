# Spec 20: Built-in Tools

**Status:** Implemented  
**Location:** `packages/core/src/builtin-tools/`

## Overview

Built-in工具直接内置在 `@walle-agent/core` 中，创建 Agent 时**默认自动注册**，无需额外安装或配置。

对齐 DeepAgents 的设计：Agent 创建即可使用文件系统、Shell、计划管理等能力。

## Tool 列表

| Tool               | 分类        | Risk   | 需要审批 | 说明                                                                                                         |
| ------------------ | ----------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------ |
| ls                 | filesystem  | low    | No       | 列出目录内容                                                                                                 |
| read_file          | filesystem  | low    | No       | 读取文件（支持分页）                                                                                         |
| write_file         | filesystem  | medium | Yes      | 写入/创建文件                                                                                                |
| edit_file          | filesystem  | medium | Yes      | 按字符串匹配替换文件内容                                                                                     |
| glob               | filesystem  | low    | No       | glob 模式匹配文件                                                                                            |
| grep               | filesystem  | low    | No       | 搜索文件文本                                                                                                 |
| bash               | shell       | high   | Yes      | 执行 shell 命令                                                                                              |
| plan               | planning    | low    | No       | 创建/管理结构化执行计划                                                                                      |
| write_todos        | task        | low    | No       | 任务列表管理                                                                                                 |
| read_tool_result   | context     | low    | No       | 按 toolCallId 读取被 micro 压缩逐出的 tool 结果（见 [21](./21-context-compression.md)）                      |
| task               | sub-agent   | low    | No       | 动态派发任务给已注册的 sub-agent 类型（见 [14-team-swarm.md](./14-team-swarm.md#dynamic-subagenttask-工具)） |
| web_fetch          | web         | medium | No       | 拉取 URL → HTML→Markdown → 用 LLM 按 prompt 摘要（对齐 Claude Code WebFetch）                                |
| tool_search        | tool-search | low    | No       | 搜索（含被 shadow 的）工具，配合 `defer_execute_tool` 使用（见 [22](./22-tool-search.md)）                   |
| defer_execute_tool | tool-search | low    | No       | 按 qualifiedName 调用任意已注册工具，权限走 underlying tool 的 policy                                        |

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

// Coding/ADE host：把六个文件工具绑定到单个 workspace
const workspaceAgent = await Agent.create({
  name: "Workspace Walle",
  model: provider,
  workspaceRoot: "/Users/me/project",
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
  workspaceRoot?: string;
  useBuiltinTools?: boolean | BuiltinToolsConfig; // default: true
}
```

### Workspace 边界

设置 `workspaceRoot` 后，Runtime 会为该 Agent 创建独立的 filesystem tool set：

```ts
const { tools, readFileTool } = createFilesystemTools({
  workspaceRoot: "/Users/me/project",
});
```

- 相对路径以 `workspaceRoot` 为基准；绝对路径仅允许指向 root 内部。
- 所有路径都拒绝 `..` traversal 与 null byte。
- 现有目标通过 `realpath` 校验；新建目标校验最近已存在的祖先，因此不能借助
  文件或父目录 symlink 越界。
- `glob` 禁止越界 pattern/cwd、不跟随 symlink directory，并逐一验证 match；
  `grep` 复用同一匹配边界。
- `task` 创建的动态子 Agent 继承父 Agent 的 `workspaceRoot`。
- 未设置时，公开的模块级 `lsTool` / `readFileTool` 等以及 `BUILTIN_TOOLS`
  继续按 `process.cwd()` 工作，保持兼容。

公开 factory/type：`createFilesystemTools`、`FilesystemToolsOptions`、
`FilesystemToolSet`；无效 root 会抛出 `WorkspacePathError`。

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

`AgentRuntime` 通过 `createPlanTool()` 为每个 Agent 创建独立的内存 store；同一进程中
不同会话、不同 workspace 的 plan 不会互相可见。公开的 `planTool`、`getPlanStore()`、
`clearPlanStore()` 仅保留为直接调用 API 的向后兼容 singleton，runtime 不会注册它。

### write_todos

```ts
input: { action: "add"|"list"|"complete"|"remove"|"clear"; task?: string; taskId?: string; listName?: string }
```

与 plan 一样，runtime 使用 `createWriteTodosTool()` 为每个 Agent 创建独立 store，Agent
释放后该 store 可随实例回收。查询不存在的列表不会创建空 Map 项；删除最后一项或 clear
会移除对应列表。`writeTodosTool` 与 `get/clearTodoStore()` 仍作为直接调用的兼容 singleton。

### task

动态派发任务给已注册的 sub-agent 类型。完整概念与多种装配入口（糖语法、
`SubAgentsPlugin`、`createTaskTool` factory）见 [14-team-swarm.md](./14-team-swarm.md#dynamic-subagenttask-工具)。

```ts
input: {
  subagent_type: string;  // 已注册的类型名
  description: string;    // 短摘要（3-5 词），主 Agent UI 展示
  prompt: string;         // 实际派发给 sub-agent 的任务
}

// 默认输出
output: { result: string }

// 当 SubAgentDefinition.verbose === true
output: { result: string; messages: ModelMessage[]; toolCalls: ToolCallRecord[] }

// 未注册的 subagent_type
output: { error: string; available: string[] }   // 不抛异常,让 LLM 自行纠正
```

**与其他 built-in 工具的区别**:`task` 工具的入参 schema 把已注册 types 动态
枚举进 `subagent_type` 的 description——所以它**不能**是 module 级单例,而是
每个 Agent 实例化时**单独构造**一份。`BUILTIN_TOOLS` 数组里**不**包含它;
`AgentRuntime.registerBuiltinTools()` 内部用当前 Agent 的
`SubAgentRegistry` + `createTaskTool({...})` factory 构造。Runtime 同时把当前
Agent 的 `workspaceRoot` 传给 factory，子 Agent 即使重新启用 filesystem
built-ins 也沿用同一工作区边界。

**生命周期**:每次调用都 `Agent.create(...)` → `agent.run(prompt)` →
`agent.dispose()`(`finally` 块);父 signal abort 透传给 sub-agent。

**默认行为**:与其他 built-in 一样默认启用;`useBuiltinTools: { excludeTools: ["task"] }`
可关闭。Sub-agent 自己的 `useBuiltinTools` 默认 `false`(防递归)。

### web_fetch

抓取一个 URL 的内容,把 HTML 转成 Markdown,再用一个小快模型按 `prompt`
做摘要后返回。对齐 Claude Code 的 `WebFetch`,详见
[plans/builtin-web-fetch/](../plans/builtin-web-fetch/)。

```ts
input: {
  url: string;        // http:// 自动升级到 https://
  prompt: string;     // 给摘要 LLM 的 user prompt
  timeout?: number;   // ms, default 30000
}

// 成功
output: {
  url: string;            // 原始入参
  finalUrl: string;       // 升级 / 同主机重定向后的 URL
  status: number;
  contentType?: string;
  content: string;        // LLM 给出的 prompt 答案
  truncated: boolean;     // 内容是否被截断
  cached?: boolean;       // 命中 15 分钟缓存时为 true
}

// 跨主机重定向(不自动跟随,交回 LLM 决定)
output: {
  url: string;
  redirectTo: string;
  redirectHost: string;
  status: number;
  message: string;
}

// 错误
output: { error: string; url?: string; status?: number }
```

**与 `task` 类似**:`web_fetch` 也不是 module 级单例——它需要 `LLMProvider`
句柄做摘要,所以 `AgentRuntime.registerWebFetchTool()` 在 `init()` 中按
当前 Agent 的 `config.model` 单独构造一份。

**关键行为**:

- 自动 `http://` → `https://`,`finalUrl` 反映升级后的 URL
- 跨主机重定向不自动跟随,返回结构化 `{ redirectTo, redirectHost, message }`
- 同主机重定向默认最多跟 5 跳
- HTML 转 Markdown 走零依赖纯 TS 实现(去掉 `<script>/<style>` 等噪声,
  decode entities,折叠空白)
- `application/json` 自动 pretty-print 后用 ``` 包起来
- 响应体以流式方式读取，默认最多下载 2 MB；`Content-Length` 超限或实际流
  达到上限时立即取消剩余 body，并把有界内容标记为 `truncated`
- 内容超过 `maxContentChars`(默认 100_000)前截断后再喂模型
- `timeout` 和父级 `AbortSignal` 会持续覆盖 response body 消费阶段，Stop 不会
  因服务端先返回 headers、再无限挂起 body 而失效
- 每个 Agent/tool instance 独立维护 15 分钟 LRU 缓存（默认最多 128 条）；不同
  Provider profile、模型或 workspace 不会复用彼此的摘要，长驻桌面进程也不会
  无界积累 URL/prompt
- `globalThis.fetch` 不可用(Node < 20 / 沙箱)时静默跳过注册,不会让 init 崩

**默认行为**:与其他 built-in 一样默认启用;`useBuiltinTools: { excludeTools: ["web_fetch"] }`
可关闭。`riskLevel: "medium"`(出站网络访问任意 URL),不强制审批,
依赖宿主的 `permissions` 策略。

## 实现架构

```
packages/core/src/
├── builtin-tools/
│   ├── index.ts            # 汇总导出 + BUILTIN_TOOLS 数组（不含 task / web_fetch / tool_search / defer_execute_tool,见下）
│   ├── filesystem-tools.ts # module-level tools + createFilesystemTools workspace factory
│   ├── shell-tool.ts       # bash
│   ├── plan-tool.ts        # plan + createPlanTool(store?) per-Agent factory
│   ├── todo-tool.ts        # write_todos + createWriteTodosTool(store?) per-Agent factory
│   ├── task-tool.ts        # task — createTaskTool({registry, defaultModel?}) factory
│   ├── web-fetch-tool.ts   # web_fetch — createWebFetchTool({model, …}) factory + htmlToMarkdown
│   ├── tool-search.ts      # tool_search — createToolSearchTool({registry}) factory
│   └── defer-execute-tool.ts # defer_execute_tool — createDeferExecuteTool({registry, checkPermission}) factory
├── sub-agent-registry.ts   # SubAgentRegistry + SubAgentDefinition
├── agent-config.ts         # workspaceRoot + BuiltinToolsConfig + useBuiltinTools + subAgents
├── agent-runtime.ts        # init() 中自动注册 + registerBuiltinTools / registerTaskTool / registerWebFetchTool / applyToolSearchPolicy
└── index.ts                # 公开导出所有内置工具 + SubAgentRegistry/createTaskTool/createWebFetchTool
```

关键设计：

- 内置工具在 `AgentRuntime.init()` 中**先于**用户工具注册
- 用户通过 `tools: [...]` 传入的工具可以覆盖同名内置工具
- 配置 `workspaceRoot` 时，六个 filesystem tools 每 Agent 单独构造并受 root 限制
- `plan` / `write_todos` 虽保留在 `BUILTIN_TOOLS` 供兼容和枚举，但 runtime 注册前会
  替换成 per-Agent factory 实例，杜绝多会话/多 workspace 串线和进程级无界累积
- 不耦合：core 不依赖外部包，`glob` 是唯一额外依赖
- 不在 `BUILTIN_TOOLS` 数组里的工具有 `task` / `web_fetch` / `tool_search` /
  `defer_execute_tool`——它们都需要每 Agent 单独构造(分别注入 `SubAgentRegistry`、
  `LLMProvider`、`ToolRegistry`),由 `registerTaskTool` / `registerWebFetchTool` /
  `applyToolSearchPolicy` 单独构造。

## 测试

```bash
npx vitest run packages/core/tests/builtin-tools.test.ts
```

相关测试包括：

- 每个工具的基本功能
- 边界情况（文件不存在、权限错误等）
- plan 工具的完整 CRUD + 自动状态更新
- 两个 factory 及两个真实 Agent 的 plan/todo 状态隔离、空列表不驻留
- BUILTIN_TOOLS 数组完整性

## 与 DeepAgents 对比

| 能力         | DeepAgents                   | Walle                     |
| ------------ | ---------------------------- | ------------------------- |
| 文件系统工具 | ✓ (via FilesystemMiddleware) | ✓ (内置 core)             |
| Shell 执行   | ✓ (execute)                  | ✓ (bash)                  |
| 任务管理     | ✓ (write_todos)              | ✓ (write_todos)           |
| 结构化计划   | ✗                            | ✓ (plan)                  |
| 默认注册     | ✓ (middleware auto-applied)  | ✓ (useBuiltinTools: true) |
| 选择性注册   | ✓                            | ✓ (include/exclude)       |
