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

  describe("shadow API", () => {
    it("registers as shadowed when opts.shadow=true", () => {
      const registry = new ToolRegistry();
      registry.register(mockTool, { shadow: true });
      expect(registry.isShadowed("test_tool")).toBe(true);
      expect(registry.listActive()).toHaveLength(0);
      expect(registry.listShadowed()).toHaveLength(1);
      expect(registry.list()).toHaveLength(1);
    });

    it("toModelTools excludes shadowed tools", () => {
      const registry = new ToolRegistry();
      registry.register(mockTool);
      registry.register({ ...mockTool, name: "shadow_one", tags: ["mcp"] });
      registry.shadow("shadow_one");
      const tools = registry.toModelTools();
      expect(tools.map((t) => t.function.name)).toEqual(["test_tool"]);
    });

    it("get() returns shadowed tools", () => {
      const registry = new ToolRegistry();
      registry.register(mockTool, { shadow: true });
      expect(registry.get("test_tool")).toBe(mockTool);
    });

    it("shadow returns false for unknown tools", () => {
      const registry = new ToolRegistry();
      expect(registry.shadow("nope")).toBe(false);
    });

    it("unshadow round-trips", () => {
      const registry = new ToolRegistry();
      registry.register(mockTool);
      registry.shadow("test_tool");
      expect(registry.isShadowed("test_tool")).toBe(true);
      expect(registry.unshadow("test_tool")).toBe(true);
      expect(registry.isShadowed("test_tool")).toBe(false);
      expect(registry.unshadow("test_tool")).toBe(false);
    });

    it("unregister also clears shadow flag", () => {
      const registry = new ToolRegistry();
      registry.register(mockTool, { shadow: true });
      registry.unregister("test_tool");
      registry.register(mockTool); // re-register
      expect(registry.isShadowed("test_tool")).toBe(false);
    });
  });
});
