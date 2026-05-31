import { describe, it, expect } from "vitest";
import { ToolRegistry } from "../src/tool-registry.js";
import type { Tool } from "../src/tool.js";

const mockTool: Tool = {
  name: "test_tool",
  description: "A test tool",
  parameters: {
    type: "object",
    properties: {
      input: { type: "string" },
    },
    required: ["input"],
  },
  tags: ["test"],
  async execute(input) {
    return { result: input.input };
  },
};

describe("ToolRegistry", () => {
  it("should register and retrieve tools", () => {
    const registry = new ToolRegistry();
    registry.register(mockTool);

    expect(registry.has("test_tool")).toBe(true);
    expect(registry.get("test_tool")).toBe(mockTool);
  });

  it("should throw on duplicate registration", () => {
    const registry = new ToolRegistry();
    registry.register(mockTool);

    expect(() => registry.register(mockTool)).toThrow("Tool already registered: test_tool");
  });

  it("should list all tools", () => {
    const registry = new ToolRegistry();
    registry.register(mockTool);
    registry.register({ ...mockTool, name: "tool2", tags: ["other"] });

    expect(registry.list()).toHaveLength(2);
  });

  it("should filter by tag", () => {
    const registry = new ToolRegistry();
    registry.register(mockTool);
    registry.register({ ...mockTool, name: "tool2", tags: ["other"] });

    expect(registry.listByTag("test")).toHaveLength(1);
    expect(registry.listByTag("other")).toHaveLength(1);
  });

  it("should convert to model tools format", () => {
    const registry = new ToolRegistry();
    registry.register(mockTool);

    const modelTools = registry.toModelTools();
    expect(modelTools).toHaveLength(1);
    expect(modelTools[0]).toEqual({
      type: "function",
      function: {
        name: "test_tool",
        description: "A test tool",
        parameters: mockTool.parameters,
      },
    });
  });

  it("should unregister tools", () => {
    const registry = new ToolRegistry();
    registry.register(mockTool);
    expect(registry.has("test_tool")).toBe(true);

    registry.unregister("test_tool");
    expect(registry.has("test_tool")).toBe(false);
  });
});
