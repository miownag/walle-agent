import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  normalizeSettings,
} from "../defaults";

describe("settings normalization", () => {
  it("fills defaults, clamps numbers, and removes invalid array values", () => {
    const settings = normalizeSettings({
      appearance: { theme: "neon", fontSize: 999 },
      sandbox: { timeoutMs: -4, allowedCommands: ["git", "git", 42, ""] },
      permissions: { alwaysAllowTools: ["write_file", "write_file", null] },
      maxTurns: 0,
    });

    expect(settings.version).toBe(1);
    expect(settings.appearance.theme).toBe("system");
    expect(settings.appearance.fontSize).toBe(24);
    expect(settings.sandbox.timeoutMs).toBe(1_000);
    expect(settings.sandbox.allowedCommands).toEqual(["git"]);
    expect(settings.permissions.alwaysAllowTools).toEqual(["write_file"]);
    expect(settings.maxTurns).toBe(1);
  });

  it("deep-merges objects and replaces arrays", () => {
    const settings = mergeSettings(DEFAULT_SETTINGS, {
      appearance: { density: "compact" },
      permissions: { denyTools: ["shell"] },
    });

    expect(settings.appearance.theme).toBe(DEFAULT_SETTINGS.appearance.theme);
    expect(settings.appearance.density).toBe("compact");
    expect(settings.permissions.denyTools).toEqual(["shell"]);
  });

  it("keeps Evolution's required Memory dependency enabled", () => {
    const settings = mergeSettings(DEFAULT_SETTINGS, {
      capabilities: { evolution: true, memory: false },
    });
    expect(settings.capabilities.evolution).toBe(true);
    expect(settings.capabilities.memory).toBe(true);
  });
});
