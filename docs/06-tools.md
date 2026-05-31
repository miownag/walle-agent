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

### 方式二：工厂函数（推荐，更好的类型推断）

```ts
export function defineTool<TInput, TOutput>(
  config: Tool<TInput, TOutput>,
): Tool<TInput, TOutput> {
  return config;
}

const calculator = defineTool({
  name: "calculator",
  description: "Evaluate a mathematical expression.",
  parameters: {
    type: "object",
    properties: {
      expression: { type: "string", description: "Math expression to evaluate" },
    },
    required: ["expression"],
  },
  riskLevel: "low",

  async execute(input) {
    // 安全的数学表达式求值
    return { result: evaluate(input.expression) };
  },
});
```

### 方式三：从 Zod schema 生成

```ts
import { z } from "zod";
import { zodToTool } from "@walle-agent/core/zod"; // 可选集成

const fileReadTool = zodToTool({
  name: "read_file",
  description: "Read a file from the filesystem.",
  schema: z.object({
    path: z.string().describe("File path to read"),
    encoding: z.enum(["utf-8", "base64"]).default("utf-8"),
  }),
  riskLevel: "medium",

  async execute(input) {
    const content = await fs.readFile(input.path, input.encoding);
    return { content };
  },
});
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
