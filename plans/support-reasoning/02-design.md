# Support Reasoning / Thinking — Design

## 设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| ThinkingBlock 扩展 | 加 `signature?`、`data?` 两个可选字段 | Anthropic 需要 signature；redacted_thinking 需要 data；OpenAI/DeepSeek 忽略这些字段，自然兼容 |
| reasoning 配置形状 | `{ enabled?: boolean; effort?: "low"\|"medium"\|"high" }` | `enabled` 对应 DeepSeek `thinking: { type: "enabled" }`；`effort` 对应 `reasoning_effort`（OpenAI o 系列 & DeepSeek 通用）|
| 配置位置 | Provider 构造 + `LLMChatRequest.reasoning` 双层 | provider 默认 + per-request 覆盖 |
| content 形态 | 有 thinking 时写为 ContentBlock[]，否则保持 string | 向后兼容 + 下一轮能 round-trip |
| 流式顺序 | `thinking_delta` 先于 `text_delta` | 符合 DeepSeek / Anthropic 的天然顺序 |
| Anthropic 丢弃策略 | 未签名的 ThinkingBlock 在回传时丢弃 | Anthropic API 会拒绝未签名 thinking；丢弃比错发安全 |

## 数据流（OpenAI / DeepSeek）

```
DeepSeek API (stream)
    │  delta.reasoning_content = "Let me ..."
    ▼
transformOpenAIStream
    │  yield { type: "thinking_delta", content }
    │  accumulate in thinkingParts[]
    ▼
message_complete
    │  content = [ThinkingBlock, TextBlock]
    ▼
agent-runtime pushes to messages[]
    │  (unmodified)
    ▼
Next turn → toOpenAIMessages
    │  assistant: { content: text, reasoning_content: thinking }
    ▼
DeepSeek API ✅ (no more 400 error)
```

## 数据流（Anthropic 扩展思考）

```
Anthropic API (stream)
    │  content_block_start { type: "thinking" }
    │  content_block_delta { thinking_delta }
    │  content_block_delta { signature_delta }
    ▼
transformAnthropicStream
    │  accumulate { thinking, signature }
    │  yield thinking_delta
    ▼
message_complete
    │  content = [ThinkingBlock(signature), TextBlock]
    ▼
Next turn → toAnthropicMessages
    │  assistant content: [{type:"thinking", thinking, signature}, {type:"text"}]
    ▼
Anthropic API ✅
```

## 关键文件改动

| 文件 | 改动 |
|------|------|
| `packages/core/src/message.ts` | 扩展 `ThinkingBlock` |
| `packages/core/src/llm-provider.ts` | 加 `ReasoningConfig` 与 `LLMChatRequest.reasoning` |
| `packages/core/src/index.ts` | 导出 `ReasoningConfig` |
| `packages/openai/src/openai-provider.ts` | Config 加 `reasoning`，请求合并 `buildReasoningExtras` |
| `packages/openai/src/message-adapter.ts` | 读取 `reasoning_content`；流式 `thinking_delta`；ContentBlock[] 构建 |
| `packages/anthropic/src/message-adapter.ts` | 保留 signature；多轮回传 thinking/redacted_thinking block |

## 风险与缓解

1. **OpenAI SDK 类型不覆盖 `thinking` / `reasoning_content`**
   - 缓解：以 `as any` 透传 extras；类型边界控制在 adapter 内
2. **DeepSeek 流式 chunk 格式可能略异**
   - 缓解：用 `(delta as any).reasoning_content` 宽松访问
3. **Anthropic 不接受未签名 thinking**
   - 缓解：`toAnthropicMessages` 过滤未签名块，只保留带 signature 或 data 的
