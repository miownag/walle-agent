# 05 — LLM Provider

## 设计目标

1. 统一 OpenAI / Anthropic 的消息格式差异
2. 支持多模态消息（text/image/tool_use/tool_result/thinking）
3. 流式和非流式双接口
4. Provider 负责格式转换，core 只看内部统一格式

---

## LLMProvider Interface

```ts
export interface LLMProvider {
  /** Provider 标识 */
  name: string;

  /** 非流式调用 */
  chat(request: LLMChatRequest): Promise<LLMChatResponse>;

  /** 流式调用 */
  stream(request: LLMChatRequest): AsyncIterable<LLMStreamChunk>;

  /** 可选：embedding 能力 */
  embeddings?(input: string[]): Promise<number[][]>;

  /** 可选：token 计数 */
  countTokens?(messages: ModelMessage[]): Promise<number>;
}
```

---

## 请求/响应类型

```ts
export interface LLMChatRequest {
  messages: ModelMessage[];
  tools?: ModelToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
  responseFormat?: "text" | "json";
  /** 推理/思考控制（每次请求可覆盖 provider 默认） */
  reasoning?: ReasoningConfig;
  metadata?: Record<string, unknown>;
}

export interface ReasoningConfig {
  /** 启用 provider 的 thinking/推理模式 */
  enabled?: boolean;
  /** 推理强度（OpenAI o 系列 / DeepSeek） */
  effort?: "low" | "medium" | "high";
}

export interface LLMChatResponse {
  message: ModelMessage;
  toolCalls?: ModelToolCall[];
  usage?: TokenUsage;
  metadata?: Record<string, unknown>;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}
```

---

## 多模态消息格式

核心消息格式必须同时兼容 OpenAI 和 Anthropic 的能力：

```ts
export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";

  /**
   * 内容可以是 string 或 ContentBlock 数组。
   * - string: 纯文本（兼容简单场景）
   * - ContentBlock[]: 多模态/结构化（图片、tool_use、thinking 等）
   */
  content?: string | ContentBlock[];

  /** tool message 专用：对应的 tool call ID */
  toolCallId?: string;

  /** assistant message 中的 tool calls */
  toolCalls?: ModelToolCall[];
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock;

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  source:
    | { type: "base64"; mediaType: string; data: string }
    | { type: "url"; url: string };
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string | ContentBlock[];
  isError?: boolean;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  /** Anthropic 签名思考（多轮回传必需） */
  signature?: string;
  /** Anthropic redacted_thinking 的不透明 payload */
  data?: string;
}
```

---

## ModelToolCall / ModelToolDefinition

```ts
export interface ModelToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: JSONSchema;
  };
}
```

---

## Stream Chunk 类型

```ts
export type LLMStreamChunk =
  | { type: "text_delta"; content: string }
  | { type: "thinking_delta"; content: string }
  | { type: "tool_call_delta"; toolCallId: string; name?: string; argumentsDelta?: string }
  | { type: "message_complete"; message: ModelMessage; toolCalls?: ModelToolCall[]; usage?: TokenUsage }
  | { type: "error"; error: Error };
```

---

## OpenAI Provider 实现要点

```ts
// @walle-agent/openai

import OpenAI from "openai";

export interface OpenAIProviderConfig {
  apiKey?: string;
  baseURL?: string;
  model: string;
  organization?: string;
  defaultTemperature?: number;
  defaultMaxTokens?: number;
}

export class OpenAIProvider implements LLMProvider {
  name = "openai";
  private client: OpenAI;
  private model: string;

  constructor(config: OpenAIProviderConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey ?? process.env.OPENAI_API_KEY,
      baseURL: config.baseURL,
      organization: config.organization,
    });
    this.model = config.model;
  }

  async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    const openaiMessages = toOpenAIMessages(request.messages);
    const openaiTools = request.tools?.map(toOpenAITool);

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: openaiMessages,
      tools: openaiTools,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
    });

    return fromOpenAIResponse(response);
  }

  async *stream(request: LLMChatRequest): AsyncIterable<LLMStreamChunk> {
    const openaiMessages = toOpenAIMessages(request.messages);
    const openaiTools = request.tools?.map(toOpenAITool);

    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: openaiMessages,
      tools: openaiTools,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stream: true,
    });

    // 转换 OpenAI stream chunks → 内部 LLMStreamChunk
    yield* transformOpenAIStream(stream);
  }
}
```

---

## Anthropic Provider 实现要点

```ts
// @walle-agent/anthropic

import Anthropic from "@anthropic-ai/sdk";

export interface AnthropicProviderConfig {
  apiKey?: string;
  model: string;
  defaultMaxTokens?: number;
  thinking?: { enabled: boolean; budgetTokens?: number };
}

export class AnthropicProvider implements LLMProvider {
  name = "anthropic";
  private client: Anthropic;
  private model: string;

  constructor(config: AnthropicProviderConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey ?? process.env.ANTHROPIC_API_KEY,
    });
    this.model = config.model;
  }

  async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    const { system, messages } = toAnthropicMessages(request.messages);
    const tools = request.tools?.map(toAnthropicTool);

    const response = await this.client.messages.create({
      model: this.model,
      system,
      messages,
      tools,
      max_tokens: request.maxTokens ?? 4096,
    });

    return fromAnthropicResponse(response);
  }

  async *stream(request: LLMChatRequest): AsyncIterable<LLMStreamChunk> {
    const { system, messages } = toAnthropicMessages(request.messages);
    const tools = request.tools?.map(toAnthropicTool);

    const stream = this.client.messages.stream({
      model: this.model,
      system,
      messages,
      tools,
      max_tokens: request.maxTokens ?? 4096,
    });

    yield* transformAnthropicStream(stream);
  }
}
```

---

## Message Adapter 职责

每个 Provider 包需要实现双向转换：

```ts
// 内部格式 → Provider 格式
function toOpenAIMessages(messages: ModelMessage[]): OpenAI.ChatCompletionMessage[];
function toAnthropicMessages(messages: ModelMessage[]): { system: string; messages: Anthropic.Message[] };

// Provider 格式 → 内部格式
function fromOpenAIResponse(response: OpenAI.ChatCompletion): LLMChatResponse;
function fromAnthropicResponse(response: Anthropic.Message): LLMChatResponse;

// Provider stream → 内部 stream chunks
function* transformOpenAIStream(stream: OpenAI.Stream): AsyncGenerator<LLMStreamChunk>;
function* transformAnthropicStream(stream: Anthropic.MessageStream): AsyncGenerator<LLMStreamChunk>;
```

关键转换逻辑：

| 内部格式 | OpenAI | Anthropic |
|----------|--------|-----------|
| `content: string` | `content: string` | `content: [{ type: "text", text }]` |
| `content: ContentBlock[]` | 拆分为 `content` + `tool_calls` | 直接映射 content blocks |
| `ThinkingBlock` | ✅ 通过 `reasoning_content`（DeepSeek）/ `reasoning_effort`（o 系列） | `{ type: "thinking", signature }` |
| `role: "tool"` | `role: "tool"` | 合并进 `user` role 的 `tool_result` block |

---

## Thinking / Reasoning 支持

Walle 通过 `ThinkingBlock` 统一承载两类 provider 的「思考」内容，做到 **开启 → 读取 → 存储 → 多轮回传** 全链路。

### 开启方式

**Provider 默认**：构造时配置。

```ts
new OpenAIProvider({
  model: "deepseek-v4-pro",
  baseURL: "https://api.deepseek.com",
  apiKey: process.env.API_KEY,
  reasoning: { enabled: true, effort: "medium" }, // DeepSeek thinking mode
});

new AnthropicProvider({
  model: "claude-sonnet-4-6",
  thinking: { enabled: true, budgetTokens: 10000 }, // Anthropic extended thinking
});
```

**每请求覆盖**：在 `LLMChatRequest` 传 `reasoning`。

### Content 形态规则

当响应含有思考内容时，`ModelMessage.content` 会被写成 `ContentBlock[]`（ThinkingBlock 在前、TextBlock 在后）；
否则保持为 `string`。这保证：

- 不含 thinking 的简单场景向后兼容；
- 含 thinking 时 history 里能保留 ThinkingBlock，下一轮请求能正确回传给 API。

### 流式顺序

Provider 按天然顺序发射：先 `thinking_delta`，后 `text_delta`，最后 `message_complete`。UI 可以据此渲染「思考中…回答」分段。

### Provider 差异

| 方面 | OpenAI / DeepSeek | Anthropic |
|------|-------------------|-----------|
| 请求参数 | `thinking: { type: "enabled" }` + `reasoning_effort` | `thinking: { type: "enabled", budget_tokens }` |
| 响应字段 | `message.reasoning_content`（非流式）/ `delta.reasoning_content`（流式） | `content[]` 中的 `thinking` block + `signature_delta` |
| 多轮回传 | 在 assistant 消息上附 `reasoning_content: string` | 回传完整 `{ type: "thinking", thinking, signature }` block |
| 签名 | 无 | 必需——未签名 thinking 会被拒绝；redacted 场景用 `data` |

### 示例

`examples/thinking.ts`：DeepSeek thinking mode 流式演示，分别打印「思考」与「回答」。
