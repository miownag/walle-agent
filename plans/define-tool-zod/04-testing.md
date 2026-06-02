# defineTool — Zod / MCP-style — Testing

## Unit — `packages/core/tests/define-tool.test.ts`(新建)

### `zodShapeToJsonSchema`

| 用例                          | 输入                                                          | 期望                                                                      |
| ----------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 平铺基本类型                  | `{ s: z.string(), n: z.number(), b: z.boolean() }`            | `properties` 包含 3 个字段且 `type` 正确;`required` 包含全部三个字段。   |
| `.describe()` 透传            | `{ x: z.string().describe("the X") }`                         | `properties.x.description === "the X"`。                                  |
| optional 不进 required        | `{ a: z.string(), b: z.string().optional() }`                 | `required` 仅 `["a"]`,`properties.b.type === "string"`。                 |
| default 不进 required + 默认值 | `{ n: z.number().default(5) }`                                | `required` 不含 `n`,`properties.n.default === 5`。                       |
| enum                          | `{ kind: z.enum(["a", "b"]) }`                                | `properties.kind.enum === ["a", "b"]`,`type === "string"`。              |
| 数组                          | `{ xs: z.array(z.string()) }`                                 | `properties.xs.type === "array"`,`items.type === "string"`。             |
| 嵌套对象                      | `{ user: z.object({ id: z.string() }) }`                      | 二层 `properties.user.properties.id.type === "string"` 且 `required: ["id"]`。 |
| union                         | `{ v: z.union([z.string(), z.number()]) }`                    | `properties.v.anyOf.length === 2`。                                       |
| 顶层无 `$schema` 字段         | 任意                                                          | 输出对象不含 `$schema` 键。                                               |

### `defineTool` 行为

| 用例                              | 预期                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 五参数签名能编译且推导 args 类型  | tsc 不报错(测试里写 `args.q` 直接当 string 用)。                                                          |
| handler 拿到 zod parse 后的对象   | 传入字符串 `"5"` 给 `z.number()` 时 execute 抛 ZodError;传入合法值 handler 收到正确类型。                  |
| extras 字段写入 Tool              | `tool.riskLevel === "high"`、`tool.requiresApproval === true`、`tool.tags === ["x"]`、`tool.annotations.readOnlyHint === true`。 |
| 没传 extras 也能工作              | `tool.riskLevel === undefined` 等。                                                                        |
| `parameters` 是 JSON Schema       | `tool.parameters.type === "object"` 且 `properties.q.type === "string"`(即派生路径走通)。                |

## Migration — 已有测试套保持绿色

迁移的 7 个 core 测试 + 4 个子包测试套必须**保持原有断言全部通过**:

- `permissions.test.ts`:`riskLevel`/`requiresApproval`/`tags` 都通过 extras 传入,行为不变。
- `integration.test.ts`:tool 调用流、permission deny、maxTurns 等全部不变。
- `tool-search.test.ts` / `tool-search-policy.test.ts` / `defer-execute-tool.test.ts`:`mkTool` helper 改写后 score / shadow / defer 逻辑不变。
- `task-tool.test.ts`:`task` 名称覆盖测试不变。
- `agent-compact.test.ts`:删除 unused import 后通过。
- `memory/tests/*.test.ts`:大 tool result 驱逐链路不变。
- `evolution/tests/*.test.ts`:技能创建链路不变。

## Build & lint

- `pnpm build` 必须全部包通过(确认 zod peer 在 tsup 下被外部化,产物 dist 不打包 zod)。
- `pnpm lint` 通过。

## 手工 sanity(可选)

- `pnpm basic` 用 mock(或不实际请求 LLM,断点确认 `calculator` tool 的 parameters 是合法 JSON Schema)。
