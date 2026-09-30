import { describe, expect, it } from "vitest";

import { highlightSource, languageForPreview } from "./syntax-highlighter";

describe("languageForPreview", () => {
  it.each([
    ["src/Panel.TSX", undefined, "tsx"],
    ["packages/api/index.go", undefined, "go"],
    ["Dockerfile", undefined, "dockerfile"],
    ["infra/CMakeLists.txt", undefined, "cmake"],
    ["schema.prisma", undefined, "prisma"],
    ["windows\\script.ps1", undefined, "powershell"],
    ["README", "markdown", "markdown"],
  ])("maps %s to %s", (relativePath, hint, expected) => {
    expect(languageForPreview(relativePath, hint)).toBe(expected);
  });

  it("prefers the file extension and rejects unknown hints", () => {
    expect(languageForPreview("script.py", "typescript")).toBe("python");
    expect(languageForPreview("artifact.walle", "made-up-language")).toBeNull();
    expect(languageForPreview("LICENSE", "text")).toBeNull();
  });
});

describe("highlightSource", () => {
  it("returns escaped token data rather than executable HTML", async () => {
    const code =
      '<script>window.pwned = true</script>\nconst safe = "<b>text</b>";';
    const result = await highlightSource(code, "typescript", "dark");
    const reconstructed = result.lines
      .map((line) => line.map((token) => token.content).join(""))
      .join("\n");

    expect(reconstructed).toBe(code);
    expect(result.theme).toBe("github-dark");
    expect(result.lines.flat().some((token) => token.color)).toBe(true);
  });
});
