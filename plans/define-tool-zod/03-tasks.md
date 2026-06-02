# defineTool — Zod / MCP-style — Tasks

## Phase 1 — Core API

- [x] T1.1 `packages/core/package.json` 加 `peerDependencies.zod: "^3.25.0 || ^4.0.0"` + `devDependencies.zod: "^4.0.0"`。
- [x] T1.2 重写 `packages/core/src/tool.ts`:
  - 新增 `ToolAnnotations` 类型并导出。
  - `Tool` 接口加可选 `annotations?: ToolAnnotations`。
  - 新增 `DefineToolExtras` 类型并导出。
  - 重写 `defineTool` 为 `(name, desc, zodShape, handler, extras?)` 五参签名,内部 `z.object(shape).parse(rawInput)` 后传 handler。
  - 实现 `zodShapeToJsonSchema(shape)`:优先 `z.toJSONSchema(..., { io: "input", target: "draft-7" })`,否则反射 fallback。
  - 导出 `zodShapeToJsonSchema` 供测试。
- [x] T1.3 `packages/core/src/index.ts`:导出新类型 `ToolAnnotations`、`DefineToolExtras`、`zodShapeToJsonSchema`。

## Phase 2 — Core tests

- [x] T2.1 新增 `packages/core/tests/define-tool.test.ts`(15 个用例)。
- [x] T2.2 迁移 `packages/core/tests/permissions.test.ts`(4 个 defineTool)到新签名。
- [x] T2.3 迁移 `packages/core/tests/integration.test.ts`(3 个 defineTool)。
- [x] T2.4 迁移 `packages/core/tests/tool-search.test.ts`(`mkTool` helper)。
- [x] T2.5 迁移 `packages/core/tests/tool-search-policy.test.ts`(`mkTool` helper)。
- [x] T2.6 迁移 `packages/core/tests/defer-execute-tool.test.ts`(`mkTool` helper + 1 个用真 schema 重写的用例,以适配 zod strict-strip 语义)。
- [x] T2.7 迁移 `packages/core/tests/task-tool.test.ts`(`customTask` + 1 个 malformed-input 用例改为 `rejects.toThrow()`)。
- [x] T2.8 `packages/core/tests/agent-compact.test.ts`:删除未使用的 `defineTool` import。

## Phase 3 — Core built-ins

- [x] T3.1 `packages/core/src/builtin-tools/shell-tool.ts` — `bashTool` → 新签名。
- [x] T3.2 `packages/core/src/builtin-tools/filesystem-tools.ts` — `lsTool` / `readFileTool` / `writeFileTool` / `editFileTool` / `globTool` / `grepTool` → 新签名。
- [x] T3.3 `packages/core/src/builtin-tools/todo-tool.ts` — `writeTodosTool` → 新签名。
- [x] T3.4 `packages/core/src/builtin-tools/plan-tool.ts` — `planTool` → 新签名。
- [x] T3.5 `packages/core/src/builtin-tools/task-tool.ts` — `createTaskTool` → 新签名。
- [x] T3.6 `packages/core/src/builtin-tools/read-tool-result.ts` — `readToolResultTool` → 新签名。
- [x] T3.7 `packages/core/src/builtin-tools/tool-search.ts` — `createToolSearchTool` → 新签名。
- [x] T3.8 `packages/core/src/builtin-tools/defer-execute-tool.ts` — `createDeferExecuteTool` → 新签名(`arguments` 用 `z.record(z.string(), z.unknown()).optional()`)。
- [x] T3.9 `packages/core/src/builtin-tools/web-fetch-tool.ts` — `createWebFetchTool` → 新签名。

## Phase 4 — Downstream packages

- [x] T4.1 `packages/memory/package.json` 加 peer + dev zod。
- [x] T4.2 `packages/memory/src/remember-tools.ts` — `rememberTool` / `recallTool` / `forgetTool` → 新签名。
- [x] T4.3 `packages/memory/tests/memory-plugin.integration.test.ts` 迁移(3 个 defineTool)。
- [x] T4.4 `packages/memory/tests/resume.integration.test.ts` 迁移(2 个 defineTool)。
- [x] T4.5 `packages/team/package.json` 加 peer + dev zod。
- [x] T4.6 `packages/team/src/sub-agent-tool.ts` — `createSubAgentTool` → 新签名。
- [x] T4.7 `packages/sandbox/package.json` 加 peer + dev zod。
- [x] T4.8 `packages/sandbox/src/shell-tool.ts` — `buildShellTool` → 新签名。
- [x] T4.9 `packages/evolution/package.json` 加 dev zod(测试用)。
- [x] T4.10 `packages/evolution/tests/evolution-plugin.integration.test.ts` 迁移 1 个 dynamic-import defineTool。

## Phase 5 — Examples + docs

- [x] T5.1 `examples/package.json` 加 `dependencies.zod`。
- [x] T5.2 `examples/basic-agent.ts` 迁移 `calculator`。
- [x] T5.3 `examples/streaming.ts` 迁移 `webSearch`。
- [x] T5.4 `examples/thinking.ts` 迁移 `calculator`。
- [x] T5.5 `examples/tool-search.ts` 迁移 `makeFakeMcpTools`。
- [x] T5.6 `README.md` Quick Start 代码片段。
- [x] T5.7 `README.zh.md` Quick Start 代码片段。
- [x] T5.8 `CLAUDE.md` Quick Start + Defining Tools 段落。
- [x] T5.9 `docs/06-tools.md`:`defineTool` 接口 + 示例。
- [x] T5.10 `docs/14-team-swarm.md`:子代理 / task tool 示例。

## Phase 6 — Verify

- [x] T6.1 `pnpm install`(让新 peer/dev 落到 lockfile)。
- [x] T6.2 `pnpm build`(全部 tsup 通过 - 13 包)。
- [x] T6.3 `pnpm test`(vitest 全部通过 - 55 文件 / 463 测试)。
- [ ] T6.4 ~~`pnpm lint`~~ — 仓库 ESLint 9 配置缺失(预存在问题,与本 PR 无关)。
