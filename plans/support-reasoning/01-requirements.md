# Support Reasoning / Thinking — Requirements

## Goal

让 Walle Agent SDK 的 LLM Provider 支持 **思考 / 推理内容**（OpenAI o 系列、DeepSeek thinking mode、Anthropic extended thinking）的完整闭环：

- **开启**：允许用户通过配置启用 provider 的 thinking/推理
- **读取**：从响应（流式+非流式）中提取 thinking 内容
- **存储**：把 thinking 持久化到 `ModelMessage.content` 的 `ThinkingBlock`
- **回传**：多轮对话时将 thinking 正确发回给 API，避免被拒绝

## Trigger

用户在 `examples/basic-agent.ts` 里用 DeepSeek（OpenAI 兼容接口）遇到：

```
BadRequestError: 400 The `reasoning_content` in the thinking mode must be passed back to the API.
```

根因是 `@walle-agent/openai` 对 `reasoning_content` 全链路失配：
- 请求端没有 `thinking` / `reasoning_effort` 参数
- `fromOpenAIResponse` 不读取 `msg.reasoning_content`
- `transformOpenAIStream` 不处理 `delta.reasoning_content`
- `toOpenAIMessages` 的 `extractThinking` 是死代码（上游从未填 ThinkingBlock）

顺带发现 `@walle-agent/anthropic` 的 `toAnthropicMessages` 对 ThinkingBlock 也有同类遗漏（丢 `signature`，导致扩展思考的多轮回传会失败）。

## Acceptance Criteria

### Core 类型
- [x] `ThinkingBlock` 新增可选 `signature` 和 `data` 字段
- [x] `LLMChatRequest` 新增可选 `reasoning: { enabled?, effort? }`
- [x] `ReasoningConfig` 类型从 core 导出

### OpenAI Provider
- [x] `OpenAIProviderConfig.reasoning` 作为 provider 默认配置
- [x] `chat()` / `stream()` 合并默认与请求级 reasoning，正确发出 `thinking` / `reasoning_effort`
- [x] `fromOpenAIResponse` 读取 `reasoning_content` → ContentBlock[]
- [x] `transformOpenAIStream` 处理 `delta.reasoning_content` → yield `thinking_delta`
- [x] 流式 `message_complete.message.content` 在有 thinking 时为 ContentBlock[]
- [x] `toOpenAIMessages` 为 assistant 消息回传 `reasoning_content`

### Anthropic Provider
- [x] `fromAnthropicResponse` 捕获 thinking block 的 `signature` 和 redacted `data`
- [x] `toAnthropicMessages` 将带 `signature` 的 ThinkingBlock 回传为 `{ type: "thinking", signature }`；redacted 回传为 `{ type: "redacted_thinking", data }`；未签名的丢弃
- [x] `transformAnthropicStream` 收集 `signature_delta` 并写入最终 ThinkingBlock

### 测试
- [x] `packages/openai/tests/message-adapter.test.ts`：非流式/流式/round-trip
- [x] `packages/anthropic/tests/message-adapter.test.ts`：signature 保留

### 示例与文档
- [x] `examples/thinking.ts` + script
- [x] `docs/05-llm-provider.md` 增「Thinking / Reasoning 支持」小节并更新对照表

## Non-Goals

- 不改动 core 运行时（`agent-runtime.ts` / `prompt-builder.ts`）——它们已透传 ContentBlock[]
- 不新增 CLI 或 UI 层功能
- 不接入新的 provider
