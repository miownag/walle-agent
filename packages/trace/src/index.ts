/**
 * @walle-agent/trace — public API.
 *
 * The plugin wraps a `TraceStore` and subscribes to the EventBus emitted by
 * `@walle-agent/core`. Two stores ship in this package; OTEL adapter is a
 * separate package (`@walle-agent/trace-otel`).
 */

export { TracePlugin } from "./trace-plugin.js";
export { JSONLTraceStore } from "./jsonl-trace-store.js";
export { InMemoryTraceStore } from "./in-memory-trace-store.js";
export type { InMemoryTraceStoreOptions } from "./in-memory-trace-store.js";
export type {
  TraceEvent,
  TraceEventType,
  TraceQuery,
  TraceStore,
  TracePluginConfig,
} from "./trace-types.js";
