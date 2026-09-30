import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("secure Electron window contract", () => {
  it("builds a CommonJS preload for the sandboxed renderer", async () => {
    const desktopRoot = process.cwd().endsWith("apps/desktop")
      ? process.cwd()
      : resolve(process.cwd(), "apps/desktop");
    const config = await readFile(
      resolve(desktopRoot, "electron.vite.config.ts"),
      "utf8",
    );
    const main = await readFile(
      resolve(desktopRoot, "src/main/index.ts"),
      "utf8",
    );

    expect(config).toContain('format: "cjs"');
    expect(config).toContain('entryFileNames: "[name].cjs"');
    expect(main).toContain('preload: join(currentDir, "../preload/index.cjs")');
    expect(main).toContain("nodeIntegration: false");
    expect(main).toContain("contextIsolation: true");
    expect(main).toContain("sandbox: true");
    expect(main).toContain("app.requestSingleInstanceLock()");
  });
});
