# 06 — Tools

## 设计原则

1. Tool 是 Agent 的"动作能力"——执行外部操作并返回结果
2. 所有工具（原生、MCP、SubAgent）注册后在 ToolRegistry 中统一管理
3. 强类型泛型支持自定义 input/output
4. 内置风险等级声明，配合权限系统

---

## Tool Interface

```ts
export interface Tool<TInput = any, TOutput = any> {
  /** 工具唯一名称（LLM function calling 用此标识） */
  name: string;

  /** 工具描述（影响 LLM 选择工具的能力） */
  description: string;

  /** JSON Schema 描述输入参数 */
  parameters: JSONSchema;

  /** 风险等级，配合 PermissionPolicy 使用 */
  riskLevel?: "low" | "medium" | "high";

  /** 是否需要人工审批 */
  requiresApproval?: boolean;

  /** 标签，用于分组/过滤 */
  tags?: string[];

  /** 执行工具 */
  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;
}

export interface ToolExecutionContext {
  /** 当前 Agent 实例 */
  agent: Agent;

  /** AbortSignal，支持取消 */
  signal?: AbortSignal;

  /** 运行时元数据 */
  metadata?: Record<string, unknown>;
}
```

---

## ToolRegistry

```ts
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  listByTag(tag: string): Tool[] {
    return this.list().filter(t => t.tags?.includes(tag));
  }

  /**
   * 转换为 LLM 可识别的 ModelToolDefinition 列表。
   */
  toModelTools(): ModelToolDefinition[] {
    return this.list().map(tool => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }
}
```

---

## ToolCallRecord

每次工具调用的记录：

```ts
export interface ToolCallRecord {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output: unknown;
  status: "success" | "error" | "denied" | "timeout";
  durationMs?: number;
  error?: string;
}
```

---

## 定义 Tool 的方式

### 方式一：对象字面量

```ts
const webSearchTool: Tool<{ query: string }, { results: SearchResult[] }> = {
  name: "web_search",
  description: "Search the web for recent information.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
    },
    required: ["query"],
  },
  riskLevel: "low",

  async execute(input) {
    const res = await fetch(`https://api.example.com/search?q=${encodeURIComponent(input.query)}`);
    return res.json();
  },
};
```

### 方式二:工厂函数 `defineTool`(推荐,Claude Agent SDK / MCP 风格)

`defineTool` 对齐 [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript#createsdkmcpserver) 的 `tool()` 签名:

```ts
import { z } from "zod";
import type {
  Tool,
  ToolAnnotations,
  DefineToolExtras,
  ToolExecutionContext,
  ZodRawShape,
} from "@walle-agent/core";

export function defineTool<Shape extends z.ZodRawShape, TOutput>(
  name: string,
  description: string,
  inputSchema: Shape,
  handler: (
    args: z.infer<z.ZodObject<Shape>>,
    context: ToolExecutionContext,
  ) => Promise<TOutput>,
  extras?: DefineToolExtras,
): Tool<z.infer<z.ZodObject<Shape>>, TOutput>;
```

- `inputSchema` 是 Zod **raw shape**(`{ field: z.string() }` 而不是 `z.object({...})`),
  库内部用 `z.object(shape)` 包装并派生 JSON Schema。
- `handler` 第一参 `args` 是 zod **parse 后**的强类型对象(自动校验)。
- `extras` 同时承载 MCP 风格的 `annotations`(`readOnlyHint` / `destructiveHint`
  / `idempotentHint` / `openWorldHint` / `title`)和 Walle 自有的
  `riskLevel` / `requiresApproval` / `tags`。

```ts
import { z } from "zod";
import { defineTool } from "@walle-agent/core";

const calculator = defineTool(
  "calculator",
  "Evaluate a mathematical expression.",
  {
    expression: z.string().describe("Math expression to evaluate"),
  },
  async ({ expression }) => {
    return { result: evaluate(expression) };
  },
  {
    riskLevel: "low",
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
);
```

### 方式三:让 Zod 描述更复杂的 schema

`defineTool` 已经原生接受 zod。复杂场景直接用 zod 的 `.optional()` /
`.default()` / `z.enum()` / `z.array()` / 嵌套 `z.object()` 等:

```ts
import { z } from "zod";
import { defineTool } from "@walle-agent/core";

const fileReadTool = defineTool(
  "read_file",
  "Read a file from the filesystem.",
  {
    path: z.string().describe("File path to read"),
    encoding: z.enum(["utf-8", "base64"]).default("utf-8"),
  },
  async ({ path, encoding }) => {
    const content = await fs.readFile(path, encoding);
    return { content };
  },
  { riskLevel: "medium" },
);
```

---

## Tool 执行流程

```
LLM 返回 tool_call
  │
  ├─ ToolRegistry.get(name)
  │     └─ 找不到 → 返回 error record
  │
  ├─ Permission Check (见 13-permissions.md)
  │     └─ denied → 返回 denied record
  │
  ├─ Hook: beforeToolCall
  │
  ├─ Tool.execute(input, context)
  │     └─ 如果 tool 标记了 sandbox → 委托 Sandbox 执行
  │
  ├─ Hook: afterToolCall
  │
  └─ 返回 ToolCallRecord
```

---

## 内置 Utility Tools（可选，core 不强制包含）

建议 core 只导出接口和注册机制，具体 tools 由用户或插件提供。但可以提供 `@walle-agent/tools` 包：

```ts
// @walle-agent/tools (可选包)
export { webSearchTool } from "./web-search";
export { shellTool } from "./shell";
export { fileReadTool } from "./file-read";
export { fileWriteTool } from "./file-write";
export { httpRequestTool } from "./http-request";
```
