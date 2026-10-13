import {
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { ComposerProps } from "./composer";
import { Composer } from "./composer";
import type {
  ProviderProfile,
  SavedImageAttachment,
  ThreadRecord,
  WorkspaceFileMatch,
} from "@shared/contracts";

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);

beforeAll(() => {
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [new DOMRect()],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  });
});

const thread: ThreadRecord = {
  id: "thread-1",
  sessionId: "session-1",
  title: "Composer test",
  workspaceRoot: "/repo",
  workspaceName: "repo",
  providerProfileId: "provider-1",
  model: "model-1",
  pinned: false,
  archived: false,
  unread: false,
  status: "idle",
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
};

const providers: ProviderProfile[] = [
  {
    id: "provider-1",
    name: "Provider",
    kind: "openai",
    model: "model-1",
    hasApiKey: true,
    isDefault: true,
  },
];

function pngFile(name = "shot.png"): File {
  return new File([PNG_BYTES], name, { type: "image/png" });
}

function pngFileWithSize(name: string, size: number): File {
  const file = pngFile(name);
  Object.defineProperty(file, "size", { configurable: true, value: size });
  return file;
}

function clipboardEvent(
  target: HTMLElement,
  items: Array<{
    kind: string;
    type: string;
    getAsFile(): File | null;
  }>,
  text = "",
) {
  const event = createEvent.paste(target, {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "clipboardData", {
    configurable: true,
    value: {
      items,
      files: items
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file)),
      types: text ? ["text/plain"] : [],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
  fireEvent(target, event);
  return event;
}

function pasteText(target: HTMLElement, text: string) {
  return clipboardEvent(target, [], text);
}

function fileItem(file: File) {
  return {
    kind: "file",
    type: file.type,
    getAsFile: () => file,
  };
}

function renderComposer(overrides: Partial<ComposerProps> = {}) {
  const props: ComposerProps = {
    thread,
    providers,
    permissionMode: "ask",
    maxContextTokens: 128_000,
    running: false,
    focused: false,
    onSend: vi.fn(async () => undefined),
    onStop: vi.fn(async () => undefined),
    onSlashCommand: vi.fn(async () => undefined),
    onProviderChange: vi.fn(async () => undefined),
    onPermissionModeChange: vi.fn(async () => undefined),
    ...overrides,
  };
  return {
    props,
    ...render(
      <TooltipProvider>
        <Composer {...props} />
      </TooltipProvider>,
    ),
  };
}

describe("Composer attachments and file mentions", () => {
  let createObjectUrl: ReturnType<typeof vi.fn>;
  let revokeObjectUrl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    let objectUrl = 0;
    createObjectUrl = vi.fn(() => `blob:walle-${++objectUrl}`);
    revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrl,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows model labels and descriptions and selects the actual value within a provider", async () => {
    const onProviderChange = vi.fn(async () => undefined);
    renderComposer({
      onProviderChange,
      providers: [
        {
          ...providers[0],
          models: [
            { value: "model-1" },
            {
              label: "Friendly model",
              value: "model-2",
              description: "Fast coding tasks",
            },
          ],
        },
      ],
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Select provider and model/ }),
    );
    expect(await screen.findByText("Fast coding tasks")).toBeInTheDocument();
    expect(screen.queryByText("Current")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Selected model")).toBeInTheDocument();
    expect(screen.getAllByText("model-1").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("Friendly model"));
    expect(onProviderChange).toHaveBeenCalledWith("provider-1", "model-2");
  });

  it("shows provider cache data as a share of the latest input", async () => {
    renderComposer({
      maxContextTokens: 256_000,
      contextWindow: {
        usedTokens: 125,
        inputTokens: 100,
        outputTokens: 25,
        cacheReadTokens: 40,
        cacheWriteTokens: 10,
        source: "provider",
        updatedAt: "2026-08-20T10:00:00.000Z",
      },
    });
    fireEvent.focus(screen.getByRole("button", { name: /Context window:/ }));
    expect(await screen.findByText("Cached input 40%")).toBeInTheDocument();
    expect(screen.getByText("Read 40 · Written 10")).toBeInTheDocument();
    expect(screen.getByText("125 of 256k tokens")).toBeInTheDocument();
  });

  it("does not intercept a normal text paste", () => {
    renderComposer();
    const textarea = screen.getByLabelText("Message Walle");
    const event = clipboardEvent(textarea, [
      {
        kind: "string",
        type: "text/plain",
        getAsFile: () => null,
      },
    ]);

    expect(event.defaultPrevented).toBe(false);
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it("shows removable pasted thumbnails, enforces the count, and revokes every object URL", async () => {
    const { unmount } = renderComposer();
    const textarea = screen.getByLabelText("Message Walle");
    const files = Array.from({ length: 5 }, (_value, index) =>
      pngFile(`shot-${index}.png`),
    );

    const event = clipboardEvent(textarea, files.map(fileItem));
    expect(event.defaultPrevented).toBe(true);
    expect(await screen.findAllByRole("img")).toHaveLength(4);
    expect(screen.getByRole("alert")).toHaveTextContent("up to 4 images");

    fireEvent.click(screen.getByRole("button", { name: "Remove shot-0.png" }));
    expect(screen.getAllByRole("img")).toHaveLength(3);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:walle-1");

    unmount();
    expect(revokeObjectUrl).toHaveBeenCalledTimes(4);
  });

  it("enforces provider-safe per-image and aggregate byte limits", async () => {
    renderComposer();
    const textarea = screen.getByLabelText("Message Walle");

    clipboardEvent(textarea, [
      fileItem(pngFileWithSize("too-large.png", 5 * 1024 * 1024 + 1)),
    ]);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("smaller than 5 MB");

    clipboardEvent(
      textarea,
      Array.from({ length: 4 }, (_value, index) =>
        fileItem(pngFileWithSize(`aggregate-${index}.png`, 4 * 1024 * 1024)),
      ),
    );
    expect(screen.getAllByRole("img")).toHaveLength(3);
    expect(screen.getByRole("alert")).toHaveTextContent("up to 15 MB together");
  });

  it("supports keyboard and click selection for @ workspace files", async () => {
    const matches: WorkspaceFileMatch[] = [
      {
        name: "a.ts",
        relativePath: "src/a.ts",
        path: "/repo/src/a.ts",
      },
      {
        name: "b.ts",
        relativePath: "src/b.ts",
        path: "/repo/src/b.ts",
      },
    ];
    const onSearchWorkspaceFiles = vi.fn(async () => matches);
    renderComposer({ onSearchWorkspaceFiles });
    const editor = screen.getByLabelText("Message Walle");

    pasteText(editor, "Review @src");
    expect(
      await screen.findByRole("option", { name: "src/a.ts" }),
    ).toBeInTheDocument();
    fireEvent.keyDown(editor, { key: "ArrowDown" });
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(
      await screen.findByLabelText("Referenced file src/b.ts"),
    ).toBeInTheDocument();

    pasteText(editor, "and @a");
    const option = await screen.findByRole("option", { name: "src/a.ts" });
    fireEvent.click(option);
    expect(
      await screen.findByLabelText("Referenced file src/a.ts"),
    ).toBeInTheDocument();

    pasteText(editor, "@");
    expect(
      await screen.findByRole("listbox", { name: "Workspace files" }),
    ).toBeInTheDocument();
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(
      screen.queryByRole("listbox", { name: "Workspace files" }),
    ).not.toBeInTheDocument();
  });

  it("ignores stale @ search responses", async () => {
    let resolveFirst!: (matches: WorkspaceFileMatch[]) => void;
    let resolveSecond!: (matches: WorkspaceFileMatch[]) => void;
    const first = new Promise<WorkspaceFileMatch[]>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<WorkspaceFileMatch[]>((resolve) => {
      resolveSecond = resolve;
    });
    const onSearchWorkspaceFiles = vi.fn((_threadId: string, query: string) =>
      query === "a" ? first : second,
    );
    renderComposer({ onSearchWorkspaceFiles });
    const editor = screen.getByLabelText("Message Walle");

    pasteText(editor, "@a");
    await waitFor(() =>
      expect(onSearchWorkspaceFiles).toHaveBeenCalledWith("thread-1", "a"),
    );
    pasteText(editor, "b");
    await waitFor(() =>
      expect(onSearchWorkspaceFiles).toHaveBeenCalledWith("thread-1", "ab"),
    );
    resolveSecond([{ name: "b.ts", relativePath: "b.ts", path: "/repo/b.ts" }]);
    expect(
      await screen.findByRole("option", { name: "b.ts" }),
    ).toBeInTheDocument();

    resolveFirst([{ name: "a.ts", relativePath: "a.ts", path: "/repo/a.ts" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      screen.queryByRole("option", { name: "a.ts" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "b.ts" })).toBeInTheDocument();
  });

  it("explains that @ search needs a desktop dev restart when the main process is stale", async () => {
    renderComposer({
      onSearchWorkspaceFiles: vi.fn(async () => {
        throw new Error(
          "Error invoking remote method 'workspace:search-files': Error: No handler registered for 'workspace:search-files'",
        );
      }),
    });
    const editor = screen.getByLabelText("Message Walle");

    pasteText(editor, "@src");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Restart desktop dev to use @ file search",
    );
  });

  it("sends absolute mention/image paths without base64 and retains the draft on failure", async () => {
    const match: WorkspaceFileMatch = {
      name: "agent.ts",
      relativePath: "src/agent.ts",
      path: "/repo/src/agent.ts",
    };
    const saved: SavedImageAttachment = {
      path: "/repo/.walle/attachments/random.png",
      relativePath: ".walle/attachments/random.png",
      fileName: "random.png",
      mimeType: "image/png",
      size: PNG_BYTES.length,
    };
    const onSaveImageAttachments = vi.fn(async () => [saved]);
    const onSend = vi
      .fn<ComposerProps["onSend"]>()
      .mockRejectedValueOnce(new Error("start failed"))
      .mockResolvedValueOnce(undefined);
    renderComposer({
      onSearchWorkspaceFiles: async () => [match],
      onSaveImageAttachments,
      onSend,
    });
    const editor = screen.getByLabelText("Message Walle");

    pasteText(editor, "Review @agent");
    fireEvent.click(
      await screen.findByRole("option", { name: "src/agent.ts" }),
    );
    clipboardEvent(editor, [fileItem(pngFile("screen.png"))]);
    expect(await screen.findByAltText("screen.png")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("start failed");
    expect(editor).toHaveTextContent("Review");
    expect(
      screen.getByLabelText("Referenced file src/agent.ts"),
    ).toBeInTheDocument();
    expect(screen.getByAltText("screen.png")).toBeInTheDocument();
    expect(onSaveImageAttachments).toHaveBeenCalledWith("thread-1", [
      {
        mimeType: "image/png",
        base64: Buffer.from(PNG_BYTES).toString("base64"),
      },
    ]);
    expect(onSend).toHaveBeenCalledWith(
      "Review /repo/src/agent.ts",
      "Review @[src/agent.ts]\n\nAttached images:\n- screen.png",
      [saved],
      [
        { type: "text", text: "Review " },
        { type: "file", name: "agent.ts", relativePath: "src/agent.ts" },
        { type: "text", text: "\n\nAttached images:\n- screen.png" },
      ],
    );
    expect(onSend.mock.calls[0][0]).not.toContain(
      Buffer.from(PNG_BYTES).toString("base64"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(onSaveImageAttachments).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(editor).toHaveTextContent(""));
    expect(screen.queryByAltText("screen.png")).not.toBeInTheDocument();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:walle-1");
  });

  it("discovers and executes clear/compact from the slash command menu", async () => {
    const onSlashCommand = vi.fn(async () => undefined);
    renderComposer({ onSlashCommand });
    const editor = screen.getByLabelText("Message Walle");

    pasteText(editor, "/");
    expect(
      await screen.findByRole("listbox", { name: "Slash commands" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /\/clear/ })).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /\/compact/ }),
    ).toBeInTheDocument();

    fireEvent.keyDown(editor, { key: "ArrowDown" });
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(editor).toHaveTextContent("/compact");
    expect(onSlashCommand).not.toHaveBeenCalled();

    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(onSlashCommand).toHaveBeenCalledWith("compact"));
    expect(editor).toHaveTextContent("");
    await waitFor(() =>
      expect(editor).toHaveAttribute("contenteditable", "true"),
    );

    pasteText(editor, "/cl");
    fireEvent.click(await screen.findByRole("option", { name: /\/clear/ }));
    expect(editor).toHaveTextContent("/clear");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(onSlashCommand).toHaveBeenLastCalledWith("clear"),
    );
  });

  it("clears a stale composer error as soon as the draft changes", async () => {
    renderComposer();
    const editor = screen.getByLabelText("Message Walle");

    pasteText(editor, "/unknown");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Unknown command");

    pasteText(editor, "x");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

it("keeps a running composer editable and queues follow-ups by default", async () => {
  const { props } = renderComposer({ running: true });
  const editor = screen.getByRole("textbox", { name: "Message Walle" });
  expect(editor).toHaveAttribute("contenteditable", "true");
  expect(editor).toHaveAttribute("aria-disabled", "false");
  pasteText(editor, "Next task");
  fireEvent.click(screen.getByRole("button", { name: "Queue message" }));
  await waitFor(() =>
    expect(props.onSend).toHaveBeenCalledWith(
      "Next task",
      "Next task",
      [],
      [{ type: "text", text: "Next task" }],
      "queue",
    ),
  );
  expect(screen.getByRole("button", { name: "Stop run" })).toBeEnabled();
});

it("uses the remembered steering mode while running", async () => {
  {
    const { props } = renderComposer({ running: true, followUpMode: "steer" });
    pasteText(
      screen.getByRole("textbox", { name: "Message Walle" }),
      "Change direction",
    );
    fireEvent.click(screen.getByRole("button", { name: "Steer run" }));
    await waitFor(() =>
      expect(props.onSend).toHaveBeenCalledWith(
        "Change direction",
        "Change direction",
        [],
        [{ type: "text", text: "Change direction" }],
        "steer",
      ),
    );
  }
});
