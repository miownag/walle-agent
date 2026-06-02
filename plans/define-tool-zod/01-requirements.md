# defineTool — Zod / MCP-style — Requirements

## Why this slice

现在 `@walle-agent/core` 暴露的 `defineTool({ name, description, parameters: JSONSchema, execute })`
要求用户**手写 JSON Schema**。和 Claude Agent SDK 的 `tool()` 形态对比，差距很明显：

```ts
// Claude Agent SDK (target)
const search = tool(
  "search",
  "Search the web",
  { query: z.string() },
  async ({ query }) => ({ content: [{ type: "text", text: `…${query}` }] }),
  { annotations: { readOnlyHint: true, openWorldHint: true } },
);
```

- 类型从 zod schema 自动 infer,不需要重复写 `interface XxxInput`。
- JSON Schema 由库内部从 zod shape 派生,不需要用户手抄。
- `extras.annotations` 暴露 MCP 标准的 hint 字段(readOnlyHint / destructiveHint / idempotentHint / openWorldHint / title),便于上层做行为提示。
- 入口处 zod 自动 `parse`,handler 拿到的 `args` 是已校验的强类型对象。

我们想把 Walle 的 `defineTool` 直接对齐到这个 shape,**保留函数名 `defineTool`**(用户已经 import 这个名字),签名做破坏性升级。

## Functional requirements

### F1 — 新 `defineTool` 签名(破坏性)

```ts
function defineTool<Shape extends z.ZodRawShape, TOutput>(
  name: string,
  description: string,
  inputSchema: Shape,                          // 例:{ q: z.string(), n: z.number().optional() }
  handler: (
    args: z.infer<z.ZodObject<Shape>>,         // 已 parse 过、强类型
    context: ToolExecutionContext,
  ) => Promise<TOutput>,
  extras?: {
    annotations?: ToolAnnotations;             // MCP 风格 hint
    riskLevel?: "low" | "medium" | "high";     // Walle 权限系统
    requiresApproval?: boolean;                // Walle 权限系统
    tags?: string[];                           // 分组/筛选
  },
): Tool<z.infer<z.ZodObject<Shape>>, TOutput>;
```

返回的仍然是现有 `Tool` 接口(JSON Schema based),`parameters` 由库内部派生,
`execute` 包装中先 `zodObject.parse(rawInput)` 再调用用户 handler。

### F2 — `ToolAnnotations` 类型

对齐 Claude Agent SDK / MCP:

```ts
interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;          // 默认 false
  destructiveHint?: boolean;       // 默认 true
  idempotentHint?: boolean;        // 默认 false
  openWorldHint?: boolean;         // 默认 true
}
```

`Tool` 接口加可选 `annotations?: ToolAnnotations` 字段,方便后续被 MCP server / 权限策略消费。

### F3 — Zod → JSON Schema 内置转换器

`core` 不能引入新的运行时依赖。策略:

1. 优先用 zod 4 自带的 `z.toJSONSchema(schema, { target: 'draft-7' })`。
2. 当 `z.toJSONSchema` 不存在(zod 3 用户)时,回退到一个轻量的反射式转换器,覆盖
   `string / number / boolean / literal / enum / nativeEnum / array / object / optional / default / nullable / union / discriminatedUnion / tuple / record / any / unknown`。
3. 输出统一规范化:剥掉 `$schema` 头,描述字段从 zod `.describe()` 透传到 JSON Schema 的 `description`。

无论哪条路径,生成的 JSON Schema 必须和现有 `JSONSchema` 类型兼容、能直接喂给
OpenAI / Anthropic 的 function calling。

### F4 — 输入验证

`defineTool` 包装的 `execute` 在调用 handler 前**强制 zod parse**:

- LLM 给的 `arguments` 是 `Record<string, unknown>`,parse 后才传入 handler。
- parse 抛错时让错误向上传播 → 走原有 `tool-call-end` 错误链路(`status: "error"`)。
- 这是行为升级:旧 `defineTool` 不做任何校验。所有内置 / 子包 / 测试都同步迁移到新签名,行为对齐。

### F5 — 包依赖关系

- `packages/core/package.json`:加 `peerDependencies: { zod: "^3.25.0 || ^4.0.0" }` + `devDependencies.zod: "^4.0.0"`(供 vitest 跑测试用)。
- `packages/memory/package.json`、`packages/team/package.json`、`packages/sandbox/package.json`、
  `packages/evolution/package.json`:同样加 peer + dev zod(它们的源码或测试都用到 `defineTool`)。
- `examples/package.json`:加 `dependencies.zod: "^4.0.0"`。
- `core` 仍然零运行时依赖(peer 不算 runtime dep)。

### F6 — 内置工具 / 子包 / 测试 / examples 全部迁移

调用点 ≈ 30+ 处,本次 PR 一次性改完:

- `packages/core/src/builtin-tools/*.ts`(10 个文件)
- `packages/core/tests/*.test.ts`(7 个文件)
- `packages/memory/src/remember-tools.ts` + 2 个测试
- `packages/team/src/sub-agent-tool.ts`
- `packages/sandbox/src/shell-tool.ts`
- `packages/evolution/tests/evolution-plugin.integration.test.ts`(dynamic import)
- `examples/{basic-agent,streaming,thinking,tool-search}.ts`

### F7 — 文档同步

- `README.md` / `README.zh.md` Quick Start 代码片段。
- `CLAUDE.md` Quick Start 代码片段。
- `docs/06-tools.md` `defineTool` 接口 + 示例。
- `docs/14-team-swarm.md` 子代理工具示例。

## Non-goals (this slice)

- 不做 `createSdkMcpServer()`(独立下一个 PR)。
- 不改 `Tool` 的 `parameters` 形态(仍然是 JSON Schema,LLM provider 直接消费)。
- 不改任何 LLM provider 的 `toModelTools` 转换路径。
- 不删除"在 plugin/runtime 内手动构造一个符合 `Tool` 接口的对象然后注册"的能力(`ctx.registerTool({ name, description, parameters, execute })` 仍然合法)——`defineTool` 只是产出 `Tool` 对象的便利工厂。

## Acceptance criteria

- [ ] `pnpm build` 全绿(所有包 tsup 通过)。
- [ ] `pnpm test` 全绿(vitest 全部通过)。
- [ ] Zod shape 中的 `.describe()` 落到 JSON Schema 的 `description` 字段(对 LLM 可见)。
- [ ] handler 收到的 `args` 是 zod parse 后的对象(类型 + 运行时一致)。
- [ ] `examples/basic-agent.ts` 用新签名能正常跑(本地 mock,不需要真 API key)。
- [ ] 所有 README / docs / CLAUDE.md 里的 `defineTool` 示例都已更新到新签名。
