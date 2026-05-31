# Support Reasoning / Thinking — Testing

## 单元测试

### OpenAI adapter (`packages/openai/tests/message-adapter.test.ts`)
- `fromOpenAIResponse preserves reasoning_content as ThinkingBlock` —— 验证非流式响应带 `reasoning_content` 时正确构建 ContentBlock[]
- `fromOpenAIResponse falls back to string content when no reasoning_content` —— 向后兼容
- `toOpenAIMessages round-trips reasoning_content via assistant ThinkingBlock` —— 历史消息里的 ThinkingBlock 能正确发回为 `reasoning_content` 字段
- `transformOpenAIStream emits thinking_delta before text_delta and builds ContentBlock[]` —— 流式正确
- `transformOpenAIStream without reasoning_content keeps content as string` —— 无回归

### Anthropic adapter (`packages/anthropic/tests/message-adapter.test.ts`)
- `toAnthropicMessages preserves signed thinking block before text` —— 带 signature 的能正确回传
- `toAnthropicMessages drops unsigned thinking` —— 未签名的被丢弃（API 合规）
- `toAnthropicMessages preserves redacted_thinking via data field` —— redacted 场景
- `fromAnthropicResponse stores thinking signature on ThinkingBlock` —— 入参 round-trip

## 运行命令

```bash
# 类型 + 编译
pnpm -r build

# 单元测试
pnpm test
```

## 手动回归

需要 `.env` 配置（`examples/.env`）：
```
API_KEY=sk-xxx
BASE_URL=https://api.deepseek.com
MODEL=deepseek-v4-pro
```

```bash
# 原有示例不能回归
pnpm basic

# 新增 thinking 示例：分段输出 [思考]/[回答]/[调用工具]，不再抛 reasoning_content 必须回传错误
pnpm --filter walle-agent-examples run thinking
```

## 预期行为

1. `basic-agent.ts`：若 `.env` 里配 DeepSeek 且开启 thinking 模式（目前示例未开启），不会再报 `reasoning_content must be passed back`。因为即便开启，OpenAI adapter 现在能完整 round-trip。
2. `thinking.ts`：流式过程中先看到 `[思考] ...`，再看到 `[调用工具] calculator(...)` → 结果，再看到 `[回答] ...` 最终答案。
3. 多轮（tool call 触发的 continue）不再抛 400。
