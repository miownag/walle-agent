# Support Reasoning / Thinking — Tasks

完成顺序（已全部完成，记录为实施日志）：

- [x] **T1** 扩展 `ThinkingBlock`（`packages/core/src/message.ts`）——加 `signature?`、`data?`
- [x] **T2** 扩展 `LLMChatRequest` + 导出 `ReasoningConfig`（`packages/core/src/llm-provider.ts`、`index.ts`）
- [x] **T3** `OpenAIProviderConfig.reasoning` + `chat/stream` 合并逻辑（`packages/openai/src/openai-provider.ts`）
- [x] **T4** OpenAI adapter 读取与流式处理 `reasoning_content`；`toOpenAIMessages` 回传（`packages/openai/src/message-adapter.ts`）
- [x] **T5** Anthropic adapter signature 保留 + 多轮回传（`packages/anthropic/src/message-adapter.ts`）
- [x] **T6** `packages/openai/tests/message-adapter.test.ts`
- [x] **T7** `packages/anthropic/tests/message-adapter.test.ts`
- [x] **T8** `examples/thinking.ts` + `examples/package.json` script
- [x] **T9** `docs/05-llm-provider.md` 更新
- [x] **T10** `pnpm -r build` + `pnpm test` 验证（见 04-testing.md）

## 新增/修改文件清单

- `packages/core/src/message.ts`（修改）
- `packages/core/src/llm-provider.ts`（修改）
- `packages/core/src/index.ts`（修改）
- `packages/openai/src/openai-provider.ts`（重写）
- `packages/openai/src/message-adapter.ts`（重写）
- `packages/anthropic/src/message-adapter.ts`（重写）
- `packages/openai/tests/message-adapter.test.ts`（新建）
- `packages/anthropic/tests/message-adapter.test.ts`（新建）
- `examples/thinking.ts`（新建）
- `examples/package.json`（修改）
- `docs/05-llm-provider.md`（修改）
