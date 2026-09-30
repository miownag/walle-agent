import { stat, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("node-pty installation contract", () => {
  it("allows native builds and repairs the macOS prebuilt helper after every install", async () => {
    const desktopRoot = process.cwd().endsWith("apps/desktop")
      ? process.cwd()
      : resolve(process.cwd(), "apps/desktop");
    const rootPackage = JSON.parse(
      await readFile(resolve(desktopRoot, "../../package.json"), "utf8"),
    ) as {
      pnpm?: { onlyBuiltDependencies?: string[] };
    };
    const desktopPackage = JSON.parse(
      await readFile(resolve(desktopRoot, "package.json"), "utf8"),
    ) as {
      scripts?: Record<string, string>;
    };

    expect(rootPackage.pnpm?.onlyBuiltDependencies).toContain("node-pty");
    expect(desktopPackage.scripts?.postinstall).toBe(
      "node scripts/fix-node-pty-permissions.mjs",
    );

    if (process.platform === "darwin") {
      const require = createRequire(import.meta.url);
      const packageRoot = dirname(require.resolve("node-pty/package.json"));
      const helper = join(
        packageRoot,
        "prebuilds",
        `darwin-${process.arch}`,
        "spawn-helper",
      );
      const mode = (await stat(helper)).mode;
      expect(mode & 0o111).not.toBe(0);
    }
  });
});
