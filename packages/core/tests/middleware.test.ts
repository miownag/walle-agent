import { describe, it, expect } from "vitest";
import { MiddlewarePipeline } from "../src/middleware.js";
import type { Middleware } from "../src/middleware.js";
import type { AgentInput } from "../src/agent-config.js";

describe("MiddlewarePipeline", () => {
  it("should pass through when no middleware", async () => {
    const pipeline = new MiddlewarePipeline();
    const input: AgentInput = { content: "hello" };

    const result = await pipeline.beforeInput(input);
    expect(result).toEqual(input);
  });

  it("should transform input through middleware chain", async () => {
    const pipeline = new MiddlewarePipeline();

    const uppercaser: Middleware = {
      name: "uppercaser",
      async beforeInput(input, next) {
        const modified = {
          ...input,
          content: typeof input.content === "string" ? input.content.toUpperCase() : input.content,
        };
        return next();
      },
    };

    const prefixer: Middleware = {
      name: "prefixer",
      async beforeInput(input, next) {
        const modified = {
          ...input,
          content: typeof input.content === "string" ? `PREFIX: ${input.content}` : input.content,
        };
        return modified;
      },
    };

    pipeline.use(uppercaser);
    pipeline.use(prefixer);

    const result = await pipeline.beforeInput({ content: "test" });
    // uppercaser calls next() which passes through to prefixer
    expect(result.content).toBe("PREFIX: test");
  });

  it("should handle afterOutput in reverse order", async () => {
    const pipeline = new MiddlewarePipeline();
    const order: string[] = [];

    const mw1: Middleware = {
      name: "mw1",
      async afterOutput(result, next) {
        order.push("mw1");
        return next();
      },
    };

    const mw2: Middleware = {
      name: "mw2",
      async afterOutput(result, next) {
        order.push("mw2");
        return next();
      },
    };

    pipeline.use(mw1);
    pipeline.use(mw2);

    await pipeline.afterOutput({
      content: "test",
      messages: [],
      toolCalls: [],
      events: [],
    });

    // Reverse order: mw2 then mw1
    expect(order).toEqual(["mw2", "mw1"]);
  });

  it("should handle middleware that skips next", async () => {
    const pipeline = new MiddlewarePipeline();

    const blocker: Middleware = {
      name: "blocker",
      async beforeInput(input, _next) {
        // Don't call next — short-circuit
        return { ...input, content: "blocked" };
      },
    };

    const neverReached: Middleware = {
      name: "never-reached",
      async beforeInput(input, next) {
        return { ...input, content: "should not reach" };
      },
    };

    pipeline.use(blocker);
    pipeline.use(neverReached);

    const result = await pipeline.beforeInput({ content: "test" });
    expect(result.content).toBe("blocked");
  });
});
