import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { DesktopApi, FileEntry, FilePreview } from "@shared/contracts";
import { FilesPanel } from "./files-panel";

class ResizeObserverStub implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverStub,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 600,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => 600,
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function file(name: string, relativePath = name): FileEntry {
  return {
    name,
    path: `/workspace/${relativePath}`,
    relativePath,
    kind: "file",
    size: 12,
  };
}

function directory(name: string, relativePath = name): FileEntry {
  return {
    name,
    path: `/workspace/${relativePath}`,
    relativePath,
    kind: "directory",
  };
}

function preview(relativePath: string, content: string): FilePreview {
  return {
    path: `/workspace/${relativePath}`,
    relativePath,
    content,
    language: "typescript",
    truncated: false,
    totalBytes: content.length,
  };
}

function renderPanel(api: DesktopApi, workspaceRoot: string) {
  return render(
    <TooltipProvider>
      <div className="h-[600px] w-[600px]">
        <FilesPanel api={api} workspaceRoot={workspaceRoot} />
      </div>
    </TooltipProvider>,
  );
}

describe("FilesPanel request ordering", () => {
  it("ignores a stale root listing after switching workspaces", async () => {
    const rootA = deferred<FileEntry[]>();
    const rootB = deferred<FileEntry[]>();
    const api = {
      readDirectory: vi.fn((root: string) =>
        root === "/A" ? rootA.promise : rootB.promise,
      ),
      readFile: vi.fn(),
    } as unknown as DesktopApi;

    const view = renderPanel(api, "/A");
    await waitFor(() => expect(api.readDirectory).toHaveBeenCalledWith("/A"));
    view.rerender(
      <TooltipProvider>
        <div className="h-[600px] w-[600px]">
          <FilesPanel api={api} workspaceRoot="/B" />
        </div>
      </TooltipProvider>,
    );
    await waitFor(() => expect(api.readDirectory).toHaveBeenCalledWith("/B"));

    await act(async () => rootB.resolve([file("from-b.ts")]));
    expect(await screen.findByText("from-b.ts")).toBeInTheDocument();

    await act(async () => rootA.resolve([file("secret-from-a.ts")]));
    await waitFor(() =>
      expect(screen.queryByText("secret-from-a.ts")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("from-b.ts")).toBeInTheDocument();
  });

  it("ignores stale expanded-directory results from the previous workspace", async () => {
    const childA = deferred<FileEntry[]>();
    const childB = deferred<FileEntry[]>();
    const api = {
      readDirectory: vi.fn((root: string, relativePath?: string) => {
        if (!relativePath) return Promise.resolve([directory("src")]);
        return root === "/A" ? childA.promise : childB.promise;
      }),
      readFile: vi.fn(),
    } as unknown as DesktopApi;

    const view = renderPanel(api, "/A");
    fireEvent.click(await screen.findByRole("button", { name: /src/ }));
    await waitFor(() =>
      expect(api.readDirectory).toHaveBeenCalledWith("/A", "src"),
    );

    view.rerender(
      <TooltipProvider>
        <div className="h-[600px] w-[600px]">
          <FilesPanel api={api} workspaceRoot="/B" />
        </div>
      </TooltipProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /src/ }));
    await waitFor(() =>
      expect(api.readDirectory).toHaveBeenCalledWith("/B", "src"),
    );

    await act(async () =>
      childB.resolve([file("b-public.ts", "src/b-public.ts")]),
    );
    expect(await screen.findByText("b-public.ts")).toBeInTheDocument();

    await act(async () =>
      childA.resolve([file("a-secret.ts", "src/a-secret.ts")]),
    );
    await waitFor(() =>
      expect(screen.queryByText("a-secret.ts")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("b-public.ts")).toBeInTheDocument();
  });

  it("keeps the most recently clicked file when an older preview resolves last", async () => {
    const firstPreview = deferred<FilePreview>();
    const secondPreview = deferred<FilePreview>();
    const api = {
      readDirectory: vi.fn(() =>
        Promise.resolve([file("first.ts"), file("second.ts")]),
      ),
      readFile: vi.fn((_root: string, relativePath: string) =>
        relativePath === "first.ts"
          ? firstPreview.promise
          : secondPreview.promise,
      ),
    } as unknown as DesktopApi;

    renderPanel(api, "/workspace");
    fireEvent.click(await screen.findByRole("button", { name: /first\.ts/ }));
    fireEvent.click(screen.getByRole("button", { name: /second\.ts/ }));

    await act(async () =>
      secondPreview.resolve(preview("second.ts", "second content")),
    );
    expect(await screen.findByText("second content")).toBeInTheDocument();

    await act(async () =>
      firstPreview.resolve(preview("first.ts", "first stale content")),
    );
    await waitFor(() =>
      expect(screen.queryByText("first stale content")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("second content")).toBeInTheDocument();
  });
});
