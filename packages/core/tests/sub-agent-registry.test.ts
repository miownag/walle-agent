import { describe, it, expect } from "vitest";
import { SubAgentRegistry, type SubAgentDefinition } from "../src/sub-agent-registry.js";

const def = (type: string, extra: Partial<SubAgentDefinition> = {}): SubAgentDefinition => ({
  type,
  systemPrompt: `System prompt for ${type}`,
  ...extra,
});

describe("SubAgentRegistry", () => {
  it("registers and retrieves a definition", () => {
    const registry = new SubAgentRegistry();
    registry.register(def("researcher"));
    expect(registry.has("researcher")).toBe(true);
    expect(registry.get("researcher")?.systemPrompt).toBe("System prompt for researcher");
  });

  it("lists all registered definitions", () => {
    const registry = new SubAgentRegistry();
    registry.register(def("a"));
    registry.register(def("b"));
    const list = registry.list();
    expect(list.map((d) => d.type).sort()).toEqual(["a", "b"]);
    expect(registry.size).toBe(2);
  });

  it("types() returns the registered keys", () => {
    const registry = new SubAgentRegistry();
    registry.register(def("alpha"));
    registry.register(def("beta"));
    expect(new Set(registry.types())).toEqual(new Set(["alpha", "beta"]));
  });

  it("throws on duplicate type registration", () => {
    const registry = new SubAgentRegistry();
    registry.register(def("dup"));
    expect(() => registry.register(def("dup"))).toThrow(/already registered/i);
  });

  it("get() returns undefined for unknown types and has() returns false", () => {
    const registry = new SubAgentRegistry();
    expect(registry.get("nope")).toBeUndefined();
    expect(registry.has("nope")).toBe(false);
  });

  it("rejects empty / non-string type", () => {
    const registry = new SubAgentRegistry();
    expect(() => registry.register({ type: "" } as SubAgentDefinition)).toThrow();
    expect(() => registry.register({ type: undefined as unknown as string })).toThrow();
  });

  it("unregister removes a definition", () => {
    const registry = new SubAgentRegistry();
    registry.register(def("temp"));
    expect(registry.unregister("temp")).toBe(true);
    expect(registry.has("temp")).toBe(false);
    expect(registry.unregister("temp")).toBe(false);
  });
});
