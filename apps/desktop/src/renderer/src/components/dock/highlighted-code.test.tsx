import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HighlightedSource } from "./syntax-highlighter";
import { HighlightedCode } from "./highlighted-code";

const testState = vi.hoisted(() => ({
  resolvedTheme: "light",
}));
const highlightSourceMock = vi.hoisted(() => vi.fn());

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: testState.resolvedTheme }),
}));

vi.mock("./syntax-highlighter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./syntax-highlighter")>()),
  highlightSource: highlightSourceMock,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function highlighted(
  content: string,
  theme: "github-light" | "github-dark",
): HighlightedSource {
  return {
    background: theme === "github-dark" ? "#0d1117" : "#ffffff",
    foreground: theme === "github-dark" ? "#f0f6fc" : "#1f2328",
    language: "typescript",
    lines: [[{ color: "#0550ae", content }]],
    theme,
  };
}

describe("HighlightedCode", () => {
  beforeEach(() => {
    testState.resolvedTheme = "light";
    highlightSourceMock.mockReset();
  });

  it("rehighlights with the matching Shiki theme when appearance changes", async () => {
    highlightSourceMock.mockImplementation(
      async (content: string, _language: string, colorMode: "light" | "dark") =>
        highlighted(
          content,
          colorMode === "dark" ? "github-dark" : "github-light",
        ),
    );
    const view = render(
      <HighlightedCode content="const answer = 42" relativePath="answer.ts" />,
    );

    expect(await screen.findByText("const answer = 42")).toBeInTheDocument();
    expect(
      document.querySelector('[data-highlight-theme="github-light"]'),
    ).toBeInTheDocument();

    testState.resolvedTheme = "dark";
    view.rerender(
      <HighlightedCode content="const answer = 42" relativePath="answer.ts" />,
    );

    await waitFor(() =>
      expect(
        document.querySelector('[data-highlight-theme="github-dark"]'),
      ).toBeInTheDocument(),
    );
    expect(highlightSourceMock).toHaveBeenLastCalledWith(
      "const answer = 42",
      "typescript",
      "dark",
    );
  });

  it("keeps the latest file when an older highlight resolves last", async () => {
    const first = deferred<HighlightedSource>();
    const second = deferred<HighlightedSource>();
    highlightSourceMock.mockImplementation((content: string) =>
      content === "first source" ? first.promise : second.promise,
    );
    const view = render(
      <HighlightedCode content="first source" relativePath="first.ts" />,
    );
    await waitFor(() => expect(highlightSourceMock).toHaveBeenCalledTimes(1));

    view.rerender(
      <HighlightedCode content="second source" relativePath="second.ts" />,
    );
    await waitFor(() => expect(highlightSourceMock).toHaveBeenCalledTimes(2));
    await act(async () =>
      second.resolve(highlighted("second source", "github-light")),
    );
    expect(await screen.findByText("second source")).toBeInTheDocument();

    await act(async () =>
      first.resolve(highlighted("first source", "github-light")),
    );
    await waitFor(() =>
      expect(screen.queryByText("first source")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("second source")).toBeInTheDocument();
  });

  it("uses an escaped plain-text fallback for unknown files and highlighter failures", async () => {
    const view = render(
      <HighlightedCode
        content={'<img src=x onerror="bad()">'}
        relativePath="LICENSE"
      />,
    );
    expect(screen.getByText('<img src=x onerror="bad()">')).toBeInTheDocument();
    expect(
      document.querySelector('[data-highlight-status="plain"]'),
    ).toBeInTheDocument();
    expect(document.querySelector("img")).not.toBeInTheDocument();

    highlightSourceMock.mockRejectedValueOnce(new Error("grammar unavailable"));
    view.rerender(
      <HighlightedCode content="fallback source" relativePath="broken.ts" />,
    );
    expect(await screen.findByText("fallback source")).toBeInTheDocument();
    expect(
      document.querySelector('[data-highlight-status="fallback"]'),
    ).toBeInTheDocument();
  });
});
