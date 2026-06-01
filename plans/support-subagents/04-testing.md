# Sub-Agents — Testing

## Test plan

所有测试用 mock LLMProvider(参考 `packages/core/tests/mock-provider.ts`),不调真模型。

### 1. `packages/core/tests/sub-agent-registry.test.ts`

| # | 用例 | 预期 |
|---|------|------|
| 1 | `register(def)` 后 `has(type)` 返回 true | ✓ |
| 2 | `get(type)` 返回完整 def 对象 | ✓ |
| 3 | `list()` 返回所有已注册的 def | ✓ |
| 4 | `types()` 返回字符串数组 | ✓ |
| 5 | `register` 重复 type → throw | ✓ |
| 6 | `get(unknown)` → undefined,`has(unknown)` → false | ✓ |

### 2. `packages/core/tests/task-tool.test.ts`

| # | 用例 | 预期 |
|---|------|------|
| 1 | task 默认注册到 toolRegistry | `toolRegistry.has("task") === true` |
| 2 | `useBuiltinTools: { excludeTools: ["task"] }` → 不注册 | `toolRegistry.has("task") === false` |
| 3 | `useBuiltinTools: false` → 全部不注册(含 task) | ✓ |
| 4 | 已注册 type, execute → 返回 `{ result: <child.run().content> }` | ✓ |
| 5 | 未注册 type → `{ error, available: [...] }`,**不抛异常** | ✓ |
| 6 | `verbose: true` → 返回包含 `messages` / `toolCalls` | ✓ |
| 7 | `def.model` 未指定 → child 用父 Agent 的 model | spy `Agent.create` |
| 8 | `def.model` 指定 → child 用 def.model | spy `Agent.create` |
| 9 | 父 signal abort → child.run 收到 aborted signal | mock provider 检 signal |
| 10 | `child.dispose()` 必被调用(无论成功 / 失败) | spy |
| 11 | `inheritSession: true` → child sessionId === parent | ✓ |
| 12 | `inheritSession: false` (default) → 两 sessionId 不同 | ✓ |
| 13 | task tool description 字符串包含已注册的所有 types | ✓ |

### 3. `packages/team/tests/sub-agents-plugin.test.ts`

| # | 用例 | 预期 |
|---|------|------|
| 1 | `new SubAgentsPlugin({ types: [...] })` install 后 `toolRegistry.has("task")` | ✓ |
| 2 | plugin + `AgentConfig.subAgents` 同时使用 → install 抛错 | ✓ |
| 3 | `getRegistry()` 返回 plugin 内部 registry,可断言已注册类型 | ✓ |

### 4. 集成测试

复用 `packages/core/tests/integration.test.ts` 的模式,加一个 case:

| # | 场景 | 预期 |
|---|------|------|
| 1 | 主 Agent + 一个 sub-agent type;mock provider 返回一个 task tool call → 执行 → 主 Agent 收到 tool result → 完成 | result.content 包含 sub-agent 的回复 |

## 命令

```bash
pnpm install
pnpm build                       # 全包构建
pnpm test                        # vitest 全跑
pnpm --filter @walle-agent/core test
pnpm --filter @walle-agent/team test
```

## 通过标准

- 所有新增测试通过(预计 ~22 个用例)。
- 不破已有测试(team 包 35 个 + core 既有套件)。
- `examples/sub-agents.ts` 用 mock provider 跑通一次完整流程。
