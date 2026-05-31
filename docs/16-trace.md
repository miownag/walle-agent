# 16 — Trace & Observability

## 设计目标

1. 所有 Agent 行为可追溯
2. Trace 是自进化的基础设施（Evolution 依赖 trace 数据）
3. 支持 JSONL 本地存储 + OpenTelemetry 导出
4. 作为独立插件，但 core 内置 EventBus 作为 trace 的数据源

---

## 实现备忘（与本规格的偏差）

`@walle-agent/trace` 落地时与早期 spec 文本有几处差异，记录在此：

1. **`recordContent` 默认 `false`**：spec 没指定默认值，但 trace 数据可能进入
   生产日志系统，默认就把用户输入 / tool arguments / message content / proposal 全部
   redact 成 `"[redacted]"`。开发时显式打开 `recordContent: true` 即可看到原始数据。

2. **写入失败不 crash agent**：trace 是审计基础设施，spec 也没说，实现把
   `store.write` 包在 try/catch 里，失败时 `console.error` 后吞掉，避免存储故障
   把上层 run 拖死。

3. **新增 `customStore` 注入点**：spec 只暴露 `store: "jsonl" | "memory"` 两个
   discriminator。实现允许 `customStore: TraceStore` 直接注入实例（OTEL adapter、
   ClickHouse 客户端、测试 spy 等），优先级高于 `store`/`storePath`。这样 OTEL
   等外部 store 不需要 fork 本插件。

4. **订阅集合更全**：spec 只订阅 run/model_call/tool_call。实现还订阅了
   `collect_context`、`memory_write`、`skill_write`、`evolution_proposal`，
   覆盖 Phase-6 evolution 自评估需要的全部信号。

5. **JSONLTraceStore 容错**：spec 直接 `JSON.parse(line)`，遇到半行写入或人为污染
   会全文件失败。实现里坏行 silently 跳过，并 reverse-chronological 走目录，
   保证 `limit` 拿到的是最新结果。

6. **`InMemoryTraceStore.maxSize` 可注入**：spec 写死 10000；实现暴露构造参数。

7. **`dispose()` 实际清理**：spec 没声明 `TraceStore.dispose`。实现把它列为
   接口的 optional 方法，`InMemoryTraceStore` 实现为清空 buffer，TracePlugin
   `dispose()` 转发过去。

---

## TraceEvent 类型

```ts
export interface TraceEvent {
  id: string;
  traceId: string;
  parentId?: string;
  type: TraceEventType;
  timestamp: string;
  durationMs?: number;
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type TraceEventType =
  | "run_start"
  | "run_end"
  | "run_error"
  | "model_call_start"
  | "model_call_end"
  | "tool_call_start"
  | "tool_call_end"
  | "memory_read"
  | "memory_write"
  | "skill_read"
  | "skill_write"
  | "evolution_trigger"
  | "evolution_proposal"
  | "permission_check"
  | "context_collect";
```

---

## Trace Plugin

```ts
export interface TracePluginConfig {
  /** 存储后端 */
  store?: "jsonl" | "memory";

  /** JSONL 存储路径 */
  storePath?: string;

  /** 是否导出到 OTEL */
  otel?: {
    enabled: boolean;
    endpoint?: string;
    serviceName?: string;
  };

  /** 是否记录完整消息内容（可能包含敏感信息） */
  recordContent?: boolean;

  /** 采样率 0-1（1 = 全量记录） */
  sampleRate?: number;
}

export class TracePlugin implements WallePlugin {
  name = "trace";

  private store: TraceStore;
  private currentTraceId?: string;

  constructor(private readonly config: TracePluginConfig = {}) {}

  async install(ctx: AgentContext): Promise<void> {
    this.store = this.createStore();

    // 订阅所有关键事件
    ctx.events.on("run_start", async ({ input }) => {
      this.currentTraceId = crypto.randomUUID();
      await this.record({
        type: "run_start",
        data: {
          input: this.config.recordContent ? input.content : "[redacted]",
          userId: input.userId,
          sessionId: input.sessionId,
        },
      });
    });

    ctx.events.on("run_end", async ({ messages }) => {
      await this.record({
        type: "run_end",
        data: { messageCount: messages.length },
      });
    });

    ctx.events.on("model_call_start", async ({ messages }) => {
      await this.record({
        type: "model_call_start",
        data: { messageCount: messages.length },
      });
    });

    ctx.events.on("model_call_end", async ({ message }) => {
      await this.record({
        type: "model_call_end",
        data: {
          role: message.role,
          hasToolCalls: !!message.toolCalls?.length,
        },
      });
    });

    ctx.events.on("tool_call_start", async ({ call }) => {
      await this.record({
        type: "tool_call_start",
        data: { name: call.name, arguments: call.arguments },
      });
    });

    ctx.events.on("tool_call_end", async ({ record }) => {
      await this.record({
        type: "tool_call_end",
        data: {
          name: record.name,
          status: record.status,
          durationMs: record.durationMs,
        },
      });
    });
  }

  private async record(event: Omit<TraceEvent, "id" | "traceId" | "timestamp">): Promise<void> {
    if (this.config.sampleRate && Math.random() > this.config.sampleRate) return;

    const full: TraceEvent = {
      id: crypto.randomUUID(),
      traceId: this.currentTraceId ?? "unknown",
      timestamp: new Date().toISOString(),
      ...event,
    };

    await this.store.write(full);
  }

  private createStore(): TraceStore {
    switch (this.config.store) {
      case "memory":
        return new InMemoryTraceStore();
      case "jsonl":
      default:
        return new JSONLTraceStore(this.config.storePath ?? "./.walle/traces");
    }
  }

  getStore(): TraceStore {
    return this.store;
  }
}
```

---

## TraceStore Interface

```ts
export interface TraceStore {
  write(event: TraceEvent): Promise<void>;
  query(options: TraceQuery): Promise<TraceEvent[]>;
  getTrace(traceId: string): Promise<TraceEvent[]>;
}

export interface TraceQuery {
  traceId?: string;
  types?: TraceEventType[];
  since?: string;
  until?: string;
  limit?: number;
}
```

---

## JSONLTraceStore

```ts
export class JSONLTraceStore implements TraceStore {
  constructor(private readonly dirPath: string) {}

  async write(event: TraceEvent): Promise<void> {
    await fs.mkdir(this.dirPath, { recursive: true });

    // 按日期分文件
    const date = event.timestamp.slice(0, 10); // YYYY-MM-DD
    const filePath = path.join(this.dirPath, `${date}.jsonl`);

    await fs.appendFile(filePath, JSON.stringify(event) + "\n");
  }

  async query(options: TraceQuery): Promise<TraceEvent[]> {
    const files = await fs.readdir(this.dirPath);
    const events: TraceEvent[] = [];

    for (const file of files.sort().reverse()) {
      if (!file.endsWith(".jsonl")) continue;

      const content = await fs.readFile(path.join(this.dirPath, file), "utf-8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        const event: TraceEvent = JSON.parse(line);

        if (options.traceId && event.traceId !== options.traceId) continue;
        if (options.types?.length && !options.types.includes(event.type)) continue;
        if (options.since && event.timestamp < options.since) continue;
        if (options.until && event.timestamp > options.until) continue;

        events.push(event);
        if (options.limit && events.length >= options.limit) return events;
      }
    }

    return events;
  }

  async getTrace(traceId: string): Promise<TraceEvent[]> {
    return this.query({ traceId });
  }
}
```

---

## InMemoryTraceStore

```ts
export class InMemoryTraceStore implements TraceStore {
  private events: TraceEvent[] = [];
  private maxSize = 10000;

  async write(event: TraceEvent): Promise<void> {
    this.events.push(event);
    if (this.events.length > this.maxSize) {
      this.events = this.events.slice(-this.maxSize);
    }
  }

  async query(options: TraceQuery): Promise<TraceEvent[]> {
    let results = [...this.events];

    if (options.traceId) results = results.filter(e => e.traceId === options.traceId);
    if (options.types?.length) results = results.filter(e => options.types!.includes(e.type));
    if (options.since) results = results.filter(e => e.timestamp >= options.since!);
    if (options.until) results = results.filter(e => e.timestamp <= options.until!);
    if (options.limit) results = results.slice(0, options.limit);

    return results;
  }

  async getTrace(traceId: string): Promise<TraceEvent[]> {
    return this.events.filter(e => e.traceId === traceId);
  }
}
```

---

## OpenTelemetry Adapter（可选）

```ts
// @walle-agent/trace-otel (独立包)

import { trace, SpanKind, context } from "@opentelemetry/api";

export class OTELTraceAdapter implements TraceStore {
  private tracer = trace.getTracer("walle-agent");

  async write(event: TraceEvent): Promise<void> {
    const span = this.tracer.startSpan(event.type, {
      kind: SpanKind.INTERNAL,
      startTime: new Date(event.timestamp),
      attributes: {
        "walle.trace_id": event.traceId,
        "walle.event_type": event.type,
        ...this.flattenData(event.data),
      },
    });

    if (event.durationMs) {
      span.end(new Date(new Date(event.timestamp).getTime() + event.durationMs));
    } else {
      span.end();
    }
  }

  private flattenData(data: Record<string, unknown>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(data)) {
      result[`walle.data.${key}`] = String(value);
    }
    return result;
  }

  // query/getTrace 委托给 OTEL backend
  async query(_: TraceQuery): Promise<TraceEvent[]> { return []; }
  async getTrace(_: string): Promise<TraceEvent[]> { return []; }
}
```

---

## 使用示例

```ts
import { Agent } from "@walle-agent/core";
import { TracePlugin } from "@walle-agent/trace";

const agent = await Agent.create({
  name: "Traced-Agent",
  model: provider,
  plugins: [
    new TracePlugin({
      store: "jsonl",
      storePath: "./.walle/traces",
      recordContent: true,
      sampleRate: 1.0,
    }),
  ],
});

// 运行后可以查询 trace
const tracePlugin = agent.getPlugin<TracePlugin>("trace");
const events = await tracePlugin.getStore().query({
  types: ["tool_call_end"],
  since: "2024-01-01",
  limit: 100,
});
```
