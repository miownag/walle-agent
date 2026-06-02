/**
 * Tests for the new MCP-style `defineTool(name, desc, zodShape, handler, extras?)`
 * signature and the internal `zodShapeToJsonSchema` converter.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineTool, zodShapeToJsonSchema } from "../src/tool.js";
import type { Agent } from "../src/agent.js";
import type { ToolExecutionContext } from "../src/tool.js";

function fakeCtx(): ToolExecutionContext {
  return {
    agent: { name: "test", sessionId: "s" } as unknown as Agent,
  };
}

describe("zodShapeToJsonSchema", () => {
  it("converts flat primitive fields", () => {
    const out = zodShapeToJsonSchema({
      s: z.string(),
      n: z.number(),
      b: z.boolean(),
    });
    expect(out.type).toBe("object");
    expect(out.properties?.s?.type).toBe("string");
    expect(out.properties?.n?.type).toBe("number");
    expect(out.properties?.b?.type).toBe("boolean");
    expect(out.required).toEqual(expect.arrayContaining(["s", "n", "b"]));
    expect(out.required).toHaveLength(3);
  });

  it("forwards .describe() to JSON Schema description", () => {
    const out = zodShapeToJsonSchema({
      x: z.string().describe("the X"),
    });
    expect(out.properties?.x?.description).toBe("the X");
  });

  it("optional fields drop out of `required`", () => {
    const out = zodShapeToJsonSchema({
      a: z.string(),
      b: z.string().optional(),
    });
    expect(out.required).toEqual(["a"]);
    expect(out.properties?.b?.type).toBe("string");
  });

  it("default fields drop out of `required` and carry the default value", () => {
    const out = zodShapeToJsonSchema({
      n: z.number().default(5),
    });
    expect(out.required ?? []).not.toContain("n");
    expect(out.properties?.n?.default).toBe(5);
  });

  it("enum becomes string + enum[]", () => {
    const out = zodShapeToJsonSchema({
      kind: z.enum(["a", "b", "c"]),
    });
    expect(out.properties?.kind?.type).toBe("string");
    expect(out.properties?.kind?.enum).toEqual(["a", "b", "c"]);
  });

  it("array of strings", () => {
    const out = zodShapeToJsonSchema({
      xs: z.array(z.string()),
    });
    expect(out.properties?.xs?.type).toBe("array");
    expect(
      (out.properties?.xs?.items as { type?: string } | undefined)?.type,
    ).toBe("string");
  });

  it("nested object", () => {
    const out = zodShapeToJsonSchema({
      user: z.object({ id: z.string(), age: z.number().optional() }),
    });
    const userSchema = out.properties?.user;
    expect(userSchema?.type).toBe("object");
    expect(
      (userSchema?.properties as Record<string, { type?: string }> | undefined)?.id?.type,
    ).toBe("string");
    expect(userSchema?.required).toEqual(["id"]);
  });

  it("union becomes anyOf", () => {
    const out = zodShapeToJsonSchema({
      v: z.union([z.string(), z.number()]),
    });
    const v = out.properties?.v as { anyOf?: unknown[] } | undefined;
    expect(v?.anyOf).toBeDefined();
    expect(v?.anyOf).toHaveLength(2);
  });

  it("strips $schema header", () => {
    const out = zodShapeToJsonSchema({ q: z.string() });
    expect(out.$schema).toBeUndefined();
  });
});

describe("defineTool (MCP-style signature)", () => {
  it("produces a Tool with derived JSON Schema parameters", () => {
    const tool = defineTool(
      "echo",
      "Echo a message",
      { msg: z.string() },
      async ({ msg }) => ({ msg }),
    );

    expect(tool.name).toBe("echo");
    expect(tool.description).toBe("Echo a message");
    expect(tool.parameters.type).toBe("object");
    expect(tool.parameters.properties?.msg?.type).toBe("string");
    expect(tool.parameters.required).toEqual(["msg"]);
  });

  it("execute parses input via zod before invoking the handler", async () => {
    let seen: { x: number } | null = null;
    const tool = defineTool(
      "double",
      "Double a number",
      { x: z.number() },
      async (args) => {
        seen = args;
        return { result: args.x * 2 };
      },
    );

    const out = (await tool.execute({ x: 7 }, fakeCtx())) as { result: number };
    expect(out.result).toBe(14);
    expect(seen).toEqual({ x: 7 });
  });

  it("execute throws ZodError when input does not match the schema", async () => {
    const tool = defineTool(
      "needs_number",
      "Needs a number",
      { x: z.number() },
      async ({ x }) => x,
    );

    await expect(tool.execute({ x: "not-a-number" } as unknown as { x: number }, fakeCtx()))
      .rejects.toBeInstanceOf(z.ZodError);
  });

  it("extras are propagated to the Tool object", () => {
    const tool = defineTool(
      "danger",
      "Dangerous op",
      { cmd: z.string() },
      async () => ({ ok: true }),
      {
        riskLevel: "high",
        requiresApproval: true,
        tags: ["shell", "builtin"],
        annotations: {
          title: "Dangerous shell command",
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
        },
      },
    );

    expect(tool.riskLevel).toBe("high");
    expect(tool.requiresApproval).toBe(true);
    expect(tool.tags).toEqual(["shell", "builtin"]);
    expect(tool.annotations?.readOnlyHint).toBe(false);
    expect(tool.annotations?.destructiveHint).toBe(true);
    expect(tool.annotations?.openWorldHint).toBe(false);
    expect(tool.annotations?.title).toBe("Dangerous shell command");
  });

  it("extras are optional", () => {
    const tool = defineTool(
      "noop",
      "noop",
      {},
      async () => ({}),
    );
    expect(tool.riskLevel).toBeUndefined();
    expect(tool.requiresApproval).toBeUndefined();
    expect(tool.tags).toBeUndefined();
    expect(tool.annotations).toBeUndefined();
  });

  it("optional/default fields are honoured at runtime", async () => {
    const tool = defineTool(
      "greet",
      "Greet someone",
      {
        name: z.string(),
        loud: z.boolean().optional(),
        repeat: z.number().default(1),
      },
      async ({ name, loud, repeat }) => {
        const base = `hi ${name}`;
        const text = (loud ? base.toUpperCase() : base).repeat(repeat);
        return { text };
      },
    );

    const out = (await tool.execute({ name: "Walle" }, fakeCtx())) as {
      text: string;
    };
    expect(out.text).toBe("hi Walle");

    const out2 = (await tool.execute(
      { name: "Walle", loud: true, repeat: 2 },
      fakeCtx(),
    )) as { text: string };
    expect(out2.text).toBe("HI WALLEHI WALLE");
  });
});
