/**
 * Tool interface and helpers.
 *
 * `defineTool` follows the Claude Agent SDK's MCP-style `tool()` shape:
 *
 *   defineTool(name, description, zodShape, handler, extras?)
 *
 * The Zod *raw shape* (e.g. `{ q: z.string(), n: z.number().optional() }`) is
 * converted to JSON Schema internally and stored on the resulting `Tool` for
 * LLM provider consumption. The handler receives already-parsed, strongly-typed
 * args.
 */

import { z } from "zod";
import type { ZodRawShape, ZodTypeAny } from "zod";
import type { JSONSchema } from "./types.js";
import type { Agent } from "./agent.js";

// ─── Tool Annotations (MCP-style behavioral hints) ──────────────────

/**
 * MCP / Claude Agent SDK style tool annotations. All fields are optional and
 * provide *hints* to clients — they are not enforced by the runtime.
 *
 * @see https://code.claude.com/docs/en/agent-sdk/typescript#createsdkmcpserver
 */
export interface ToolAnnotations {
  /** Human-readable title for the tool. */
  title?: string;
  /** If true, the tool does not modify its environment. Default: false. */
  readOnlyHint?: boolean;
  /** If true, the tool may perform destructive updates. Default: true. */
  destructiveHint?: boolean;
  /** If true, repeated calls with the same arguments have no additional effect. Default: false. */
  idempotentHint?: boolean;
  /** If true, the tool interacts with external entities. Default: true. */
  openWorldHint?: boolean;
}

// ─── Tool Execution Context ────────────────────────────────────────

export interface ToolExecutionContext {
  /** Current Agent instance */
  agent: Agent;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Runtime metadata */
  metadata?: Record<string, unknown>;
}

// ─── Tool Interface ────────────────────────────────────────────────

export interface Tool<TInput = any, TOutput = any> {
  /** Unique tool name (used in LLM function calling) */
  name: string;
  /** Tool description (influences LLM tool selection) */
  description: string;
  /** JSON Schema for input parameters (auto-derived from the zod shape when defined via defineTool) */
  parameters: JSONSchema;
  /** Walle-specific risk level for the permission system */
  riskLevel?: "low" | "medium" | "high";
  /** Walle-specific human-approval gate */
  requiresApproval?: boolean;
  /** Tags for grouping/filtering */
  tags?: string[];
  /** MCP-style behavioral hints */
  annotations?: ToolAnnotations;
  /** Execute the tool */
  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;
}

// ─── Tool Call Record ──────────────────────────────────────────────

export interface ToolCallRecord {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output: unknown;
  status: "success" | "error" | "denied" | "timeout";
  durationMs?: number;
  error?: string;
}

// ─── defineTool extras ─────────────────────────────────────────────

/**
 * Optional fifth argument to `defineTool`. Combines MCP-style annotations
 * with Walle's permission / classification fields.
 */
export interface DefineToolExtras {
  /** MCP-style behavioral hints. */
  annotations?: ToolAnnotations;
  /** Walle permission risk level. */
  riskLevel?: "low" | "medium" | "high";
  /** Walle human-approval gate. */
  requiresApproval?: boolean;
  /** Tags for grouping/filtering. */
  tags?: string[];
}

// ─── defineTool (Claude Agent SDK MCP-style) ───────────────────────

/**
 * Define a tool with a Zod raw shape (the same shape used by Claude Agent SDK's
 * `tool()` and `createSdkMcpServer`).
 *
 * @example
 *   import { z } from "zod";
 *   import { defineTool } from "@walle-agent/core";
 *
 *   const search = defineTool(
 *     "search",
 *     "Search the web",
 *     { query: z.string() },
 *     async ({ query }) => ({ results: [`hit for ${query}`] }),
 *     { annotations: { readOnlyHint: true, openWorldHint: true } },
 *   );
 *
 * Behaviour:
 *  - The Zod raw shape is wrapped with `z.object(...)` and converted to JSON
 *    Schema (stored on `tool.parameters` for LLM consumption).
 *  - On `execute`, the raw input from the LLM is `parse`d by the zod object
 *    *before* being forwarded to the handler. A schema mismatch surfaces as a
 *    thrown ZodError (caught by the agent runtime as a tool-call error).
 *  - The handler's first argument is the inferred TypeScript type of the
 *    parsed object — no manual `as` cast required.
 */
export function defineTool<Shape extends ZodRawShape, TOutput>(
  name: string,
  description: string,
  inputSchema: Shape,
  handler: (
    args: z.infer<z.ZodObject<Shape>>,
    context: ToolExecutionContext,
  ) => Promise<TOutput>,
  extras?: DefineToolExtras,
): Tool<z.infer<z.ZodObject<Shape>>, TOutput> {
  const zodObject = z.object(inputSchema);
  const parameters = zodShapeToJsonSchema(inputSchema);

  return {
    name,
    description,
    parameters,
    riskLevel: extras?.riskLevel,
    requiresApproval: extras?.requiresApproval,
    tags: extras?.tags,
    annotations: extras?.annotations,
    async execute(rawInput, context) {
      const parsed = zodObject.parse(rawInput) as z.infer<z.ZodObject<Shape>>;
      return handler(parsed, context);
    },
  };
}

// ─── Zod → JSON Schema converter ───────────────────────────────────

/**
 * Convert a Zod raw shape (used as a top-level object schema) to JSON Schema.
 *
 * Strategy:
 *   1. Prefer Zod 4's built-in `z.toJSONSchema()` when available.
 *   2. Fall back to a minimal Zod-3-style reflection converter that handles
 *      the types most commonly found in tool inputs.
 */
export function zodShapeToJsonSchema(shape: ZodRawShape): JSONSchema {
  const obj = z.object(shape);

  const native = (z as unknown as {
    toJSONSchema?: (s: unknown, opts?: unknown) => unknown;
  }).toJSONSchema;
  if (typeof native === "function") {
    try {
      // `io: "input"` keeps fields with `.default(...)` out of `required`,
      // which matches what the LLM actually has to supply.
      const out = native.call(z, obj, {
        target: "draft-7",
        io: "input",
      }) as JSONSchema;
      return normaliseJsonSchema(out);
    } catch {
      // Fall through to reflection.
    }
  }

  return convertReflective(obj);
}

function normaliseJsonSchema(schema: JSONSchema): JSONSchema {
  if (!schema || typeof schema !== "object") return schema;
  // Strip the `$schema` header — most LLM function-tool consumers don't want it.
  const { $schema: _$schema, ...rest } = schema as JSONSchema & {
    $schema?: unknown;
  };
  return rest as JSONSchema;
}

interface ZodDefLike {
  typeName?: string;
  description?: string;
  innerType?: ZodTypeAny;
  type?: ZodTypeAny;
  shape?: Record<string, ZodTypeAny> | (() => Record<string, ZodTypeAny>);
  value?: unknown;
  values?: unknown;
  options?: unknown;
  optionsMap?: Map<unknown, ZodTypeAny>;
  items?: ZodTypeAny[];
  defaultValue?: unknown;
}

function getDef(schema: ZodTypeAny): ZodDefLike | undefined {
  return (schema as unknown as { _def?: ZodDefLike })._def;
}

function withDescription(out: JSONSchema, def: ZodDefLike | undefined): JSONSchema {
  if (def?.description && typeof def.description === "string") {
    return { ...out, description: def.description };
  }
  return out;
}

function isOptional(schema: ZodTypeAny): boolean {
  const def = getDef(schema);
  if (!def) return false;
  return def.typeName === "ZodOptional" || def.typeName === "ZodDefault";
}

function convertReflective(schema: ZodTypeAny): JSONSchema {
  const def = getDef(schema);
  if (!def) return {};
  switch (def.typeName) {
    case "ZodString":
      return withDescription({ type: "string" }, def);
    case "ZodNumber":
      return withDescription({ type: "number" }, def);
    case "ZodBoolean":
      return withDescription({ type: "boolean" }, def);
    case "ZodLiteral":
      return withDescription({ const: def.value }, def);
    case "ZodEnum":
      return withDescription(
        { type: "string", enum: def.values as unknown[] },
        def,
      );
    case "ZodNativeEnum":
      return withDescription(
        { enum: Object.values(def.values as Record<string, unknown>) },
        def,
      );
    case "ZodArray": {
      const inner = def.type ?? (def.innerType as ZodTypeAny | undefined);
      return withDescription(
        { type: "array", items: inner ? convertReflective(inner) : {} },
        def,
      );
    }
    case "ZodObject": {
      const rawShape =
        typeof def.shape === "function" ? def.shape() : def.shape;
      const properties: Record<string, JSONSchema> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(rawShape ?? {})) {
        properties[k] = convertReflective(v);
        if (!isOptional(v)) required.push(k);
      }
      const out: JSONSchema = { type: "object", properties };
      if (required.length > 0) out.required = required;
      return withDescription(out, def);
    }
    case "ZodOptional":
      return def.innerType ? convertReflective(def.innerType) : {};
    case "ZodDefault": {
      const inner = def.innerType ? convertReflective(def.innerType) : {};
      const dv =
        typeof def.defaultValue === "function"
          ? (def.defaultValue as () => unknown)()
          : def.defaultValue;
      return { ...inner, default: dv };
    }
    case "ZodNullable": {
      const inner = def.innerType ? convertReflective(def.innerType) : {};
      return { ...inner, nullable: true };
    }
    case "ZodUnion": {
      const opts = (def.options as ZodTypeAny[]) ?? [];
      return withDescription({ anyOf: opts.map(convertReflective) }, def);
    }
    case "ZodDiscriminatedUnion": {
      const opts =
        (def.optionsMap && Array.from(def.optionsMap.values())) ||
        (def.options as ZodTypeAny[]) ||
        [];
      return withDescription(
        { anyOf: (opts as ZodTypeAny[]).map(convertReflective) },
        def,
      );
    }
    case "ZodTuple": {
      const items = (def.items as ZodTypeAny[]) ?? [];
      // JSON Schema allows `items` to be an array of schemas (tuple form);
      // our `JSONSchema` type narrows it to a single schema, so cast through.
      return withDescription(
        {
          type: "array",
          items: items.map(convertReflective) as unknown as JSONSchema,
        },
        def,
      );
    }
    case "ZodRecord":
      return withDescription({ type: "object" }, def);
    case "ZodAny":
    case "ZodUnknown":
    case "ZodVoid":
    case "ZodNull":
      return {};
    default:
      return {};
  }
}
