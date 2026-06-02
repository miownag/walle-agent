# defineTool — Zod / MCP-style — Design

## Module map

```
packages/core/src/tool.ts                       # ★ 重写
  ├── ToolAnnotations              # 新增类型
  ├── DefineToolExtras             # 新增类型
  ├── Tool                         # 加可选 annotations 字段
  ├── defineTool(name, desc, shape, handler, extras?)
  └── zodShapeToJsonSchema(shape) — 内部导出便于测试

packages/core/tests/define-tool.test.ts         # 新增
```

## API

### `Tool` 接口

```ts
export interface Tool<TInput = any, TOutput = any> {
  name: string;
  description: string;
  parameters: JSONSchema;          // 不变,仍是 LLM provider 直接消费的 JSON Schema
  riskLevel?: "low" | "medium" | "high";
  requiresApproval?: boolean;
  tags?: string[];
  annotations?: ToolAnnotations;   // ★ 新增
  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;
}
```

### `ToolAnnotations`

```ts
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}
```

### `defineTool` 新签名

```ts
import { z } from "zod";
import type { ZodRawShape, ZodObject, infer as ZodInfer } from "zod";

export interface DefineToolExtras {
  annotations?: ToolAnnotations;
  riskLevel?: "low" | "medium" | "high";
  requiresApproval?: boolean;
  tags?: string[];
}

export function defineTool<Shape extends ZodRawShape, TOutput>(
  name: string,
  description: string,
  inputSchema: Shape,
  handler: (
    args: ZodInfer<ZodObject<Shape>>,
    context: ToolExecutionContext,
  ) => Promise<TOutput>,
  extras?: DefineToolExtras,
): Tool<ZodInfer<ZodObject<Shape>>, TOutput>;
```

实现:

```ts
const zodObject = z.object(inputSchema);
const parameters = zodShapeToJsonSchema(inputSchema);
return {
  name,
  description,
  parameters,
  riskLevel: extras?.riskLevel,
  requiresApproval: extras?.requiresApproval,
  tags: extras?.tags,
  annotations: extras?.annotations,
  async execute(rawInput, context) {
    const parsed = zodObject.parse(rawInput);
    return handler(parsed as ZodInfer<ZodObject<Shape>>, context);
  },
};
```

> 把 zod 引入做成**值导入** `import { z } from "zod"`(不是 `import type`),
> 因为运行期需要 `z.object(...).parse(...)`。peerDep 保证用户安装了 zod。

## Zod → JSON Schema converter

```ts
export function zodShapeToJsonSchema(shape: ZodRawShape): JSONSchema {
  const obj = z.object(shape);
  const builtIn = (z as unknown as { toJSONSchema?: Function }).toJSONSchema;
  if (typeof builtIn === "function") {
    try {
      const out = builtIn.call(z, obj, { target: "draft-7" }) as JSONSchema;
      return normalise(out);
    } catch {
      // fall through to reflection
    }
  }
  return reflect(obj);
}
```

### `normalise`

剥掉 `$schema` 字段(OpenAI function tool 不需要)。其余字段透传。

### `reflect` (zod 3 fallback)

按 `_def.typeName` 分发,递归处理。覆盖类型:

| typeName               | 输出 JSON Schema                                          |
| ---------------------- | --------------------------------------------------------- |
| ZodString              | `{ type: "string", description? }`                        |
| ZodNumber              | `{ type: "number", description? }`                        |
| ZodBoolean             | `{ type: "boolean", description? }`                       |
| ZodLiteral             | `{ const: value, description? }`                          |
| ZodEnum                | `{ type: "string", enum: values, description? }`          |
| ZodNativeEnum          | `{ enum: Object.values(values), description? }`           |
| ZodArray               | `{ type: "array", items: reflect(inner), description? }`  |
| ZodObject              | `{ type: "object", properties, required?, description? }` |
| ZodOptional            | `reflect(inner)` (不出现在 required 里)                   |
| ZodDefault             | `reflect(inner)` + `default: defaultValue`                |
| ZodNullable            | `reflect(inner)` + `nullable: true`                       |
| ZodUnion               | `{ anyOf: options.map(reflect) }`                         |
| ZodDiscriminatedUnion  | `{ anyOf: options.map(reflect) }`                         |
| ZodTuple               | `{ type: "array", items: items.map(reflect) }`            |
| ZodRecord              | `{ type: "object" }`                                      |
| ZodAny / ZodUnknown    | `{}`                                                      |
| 其他 / 未知            | `{}`                                                      |

`description` 取自 `def.description`(zod `.describe("...")` 的产物)。

`isOptional(schema)` 判定:`def.typeName === "ZodOptional" || def.typeName === "ZodDefault"`。

## peerDependency 设置

`packages/core/package.json` 加:

```jsonc
{
  "peerDependencies": {
    "zod": "^3.25.0 || ^4.0.0"
  },
  "devDependencies": {
    "zod": "^4.0.0",
    ...
  }
}
```

`tsup` 默认把 peer 标记为 external。

`packages/memory/package.json`、`packages/team/package.json`、`packages/sandbox/package.json`、
`packages/evolution/package.json` 同步加 peer + dev zod。

`examples/package.json` 加 `dependencies.zod: "^4.0.0"`(examples 是终端使用者,不是中间库)。

## 迁移示例对照表

| 旧写法                                                                                                                         | 新写法                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defineTool({ name: "calc", description: "…", parameters: { type: "object", properties: { x: { type: "number" } }, required: ["x"] }, async execute(input: { x: number }) { … } })` | `defineTool("calc", "…", { x: z.number() }, async ({ x }) => { … })`                                                                                                                  |
| `riskLevel: "high"` 顶层字段                                                                                                   | 第 5 个参数 `extras: { riskLevel: "high" }`                                                                                                                                           |
| `tags: ["builtin"]` 顶层字段                                                                                                   | `extras: { tags: ["builtin"] }`                                                                                                                                                       |
| `requiresApproval: true` 顶层字段                                                                                              | `extras: { requiresApproval: true }`                                                                                                                                                  |

## 内部 `Tool` 对象在 plugin 里直接构造

历史代码里有些地方不通过 `defineTool`,而是直接造一个 `Tool` 对象 push 进 registry,
例如 `tool-plugin` 测试或 MCP adapter。这些代码**不受新 `defineTool` 签名影响**——
它们直接给 `parameters: JSONSchema`,继续可用。本次只改通过 `defineTool` 工厂的路径。

## 风险与回退

- **zod 3 用户**:如果用户钉死在 zod 3,`z.toJSONSchema` 不存在,会走到 reflection。
  reflection 覆盖了实际场景里 99% 的 zod 用法,但一些边角(`z.intersection`、`z.lazy`、
  `z.preprocess` 等)会输出空 schema。本次内置工具不用这些类型,可接受。需要时再补。
- **zod 4 `z.toJSONSchema` 行为差异**:zod 4 默认输出 `additionalProperties: false`、
  `required: [...]`、不带 `$schema`(我们再保险地剥一下)。LLM provider 测试通过即视为合规。
- **运行期 parse 失败**:LLM 返回了不合 schema 的 arguments,handler 不会被调用,工具调用
  以 error 收尾。这是**期望行为**——比之前默默吞下错误数据更安全。

## Test plan

详见 `04-testing.md`。
