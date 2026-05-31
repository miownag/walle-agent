# 04 — Streaming

## 设计原则

1. **Stream-first**：执行循环内部永远是流式的，非流式 `run()` 只是 collect stream 的语法糖
2. **Typed Events**：每种 stream event 有明确类型，开发者可以精准订阅
3. **Backpressure-safe**：基于 AsyncGenerator，自然支持背压
4. **Composable**：AgentStream 提供链式 helper 方法

---

## AgentStream

```ts
/**
 * AgentStream wraps an AsyncGenerator, provides helper methods.
 */
export class AgentStream implements AsyncIterable<AgentStreamEvent> {
  private generator: AsyncGenerator<AgentStreamEvent>;

  constructor(generator: AsyncGenerator<AgentStreamEvent>) {
    this.generator = generator;
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentStreamEvent> {
    return this.generator;
  }

  /**
   * Collect all events and return final AgentResult.
   */
  async collect(): Promise<AgentResult> {
    const events: AgentStreamEvent[] = [];
    let content = "";
    const toolCalls: ToolCallRecord[] = [];
    const messages: ModelMessage[] = [];

    for await (const event of this.generator) {
      events.push(event);

      if (event.type === "text_delta") {
        content += event.content;
      }

      if (event.type === "tool_call_end") {
        toolCalls.push(event.record);
      }

      if (event.type === "model_call_end") {
        messages.push(event.message);
      }
    }

    return { content, messages, toolCalls, events };
  }

  /**
   * Only yield text content (convenience for UI rendering).
   */
  async *text(): AsyncGenerator<string> {
    for await (const event of this.generator) {
      if (event.type === "text_delta") {
        yield event.content;
      }
    }
  }

  /**
   * Pipe to a WritableStream (e.g., HTTP response).
   */
  async pipeTo(writable: WritableStream<string>): Promise<AgentResult> {
    const writer = writable.getWriter();
    const events: AgentStreamEvent[] = [];
    let content = "";
    const toolCalls: ToolCallRecord[] = [];
    const messages: ModelMessage[] = [];

    try {
      for await (const event of this.generator) {
        events.push(event);

        if (event.type === "text_delta") {
          content += event.content;
          await writer.write(event.content);
        }

        if (event.type === "tool_call_end") {
          toolCalls.push(event.record);
        }

        if (event.type === "model_call_end") {
          messages.push(event.message);
        }
      }
    } finally {
      await writer.close();
    }

    return { content, messages, toolCalls, events };
  }

  /**
   * Transform stream events (map/filter).
   */
  pipe<T>(transform: (event: AgentStreamEvent) => T | null): AsyncGenerator<T> {
    const self = this;
    return (async function* () {
      for await (const event of self.generator) {
        const result = transform(event);
        if (result !== null) yield result;
      }
    })();
  }
}
```

---

## AgentStreamEvent 类型

```ts
export type AgentStreamEvent =
  | RunStartEvent
  | RunEndEvent
  | ModelCallStartEvent
  | ModelCallEndEvent
  | TextDeltaEvent
  | ToolCallDeltaEvent
  | ToolCallStartEvent
  | ToolCallEndEvent
  | LLMChunkEvent
  | ErrorEvent;

export interface RunStartEvent {
  type: "run_start";
  input: AgentInput;
}

export interface RunEndEvent {
  type: "run_end";
}

export interface ModelCallStartEvent {
  type: "model_call_start";
  turn: number;
}

export interface ModelCallEndEvent {
  type: "model_call_end";
  message: ModelMessage;
}

export interface TextDeltaEvent {
  type: "text_delta";
  content: string;
}

export interface ToolCallDeltaEvent {
  type: "tool_call_delta";
  toolCallId: string;
  name?: string;
  argumentsDelta?: string;
}

export interface ToolCallStartEvent {
  type: "tool_call_start";
  call: ModelToolCall;
}

export interface ToolCallEndEvent {
  type: "tool_call_end";
  record: ToolCallRecord;
}

export interface LLMChunkEvent {
  type: "llm_chunk";
  chunk: LLMStreamChunk;
}

export interface ErrorEvent {
  type: "error";
  error: Error;
}
```

---

## LLMProvider Stream Interface

LLMProvider 必须同时支持 `chat()` 和 `stream()`：

```ts
export interface LLMProvider {
  name: string;

  /** 非流式调用（Provider 内部可以实现为 stream + collect） */
  chat(request: LLMChatRequest): Promise<LLMChatResponse>;

  /** 流式调用 */
  stream(request: LLMChatRequest): AsyncIterable<LLMStreamChunk>;
}

export type LLMStreamChunk =
  | { type: "text_delta"; content: string }
  | { type: "tool_call_delta"; toolCallId: string; name?: string; argumentsDelta?: string }
  | { type: "message_complete"; message: ModelMessage; toolCalls?: ModelToolCall[]; usage?: TokenUsage }
  | { type: "error"; error: Error };
```

---

## 使用示例

### 基本流式

```ts
const stream = agent.run("分析这段代码", { stream: true });

for await (const event of stream) {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.content);
      break;
    case "tool_call_start":
      console.log(`\n[Calling tool: ${event.call.name}]`);
      break;
    case "tool_call_end":
      console.log(`[Tool result: ${event.record.status}]`);
      break;
  }
}
```

### 只获取文本

```ts
const stream = agent.run("你好", { stream: true });

for await (const text of stream.text()) {
  process.stdout.write(text);
}
```

### HTTP Response 管道

```ts
// Express-style
app.post("/chat", async (req, res) => {
  const stream = agent.run(req.body.message, { stream: true });

  res.setHeader("Content-Type", "text/event-stream");

  for await (const event of stream) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  res.end();
});
```

### 非流式（自动 collect）

```ts
const result = await agent.run("你好");
console.log(result.content);
```
