import type { ComponentProps, ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { ThreadRecord } from "@shared/contracts";
import { Sidebar } from "./sidebar";

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
}));

const handlers = {
  onMobileClose: vi.fn(),
  onSelect: vi.fn(),
  onCreate: vi.fn(async () => undefined),
  onCreateInWorkspace: vi.fn(async () => undefined),
  onUpdate: vi.fn(async () => true),
  onDelete: vi.fn(async () => undefined),
  onOpenSettings: vi.fn(),
  onOpenEvolution: vi.fn(),
};

function renderSidebar(
  visible: boolean,
  overrides: Partial<ComponentProps<typeof Sidebar>> = {},
) {
  return (
    <TooltipProvider>
      <Sidebar
        threads={[]}
        activeIds={[]}
        evolutionCount={0}
        creating={false}
        visible={visible}
        mobileOpen={visible}
        {...handlers}
        {...overrides}
      />
    </TooltipProvider>
  );
}

const thread: ThreadRecord = {
  id: "thread-1",
  sessionId: "session-1",
  title: "Improve sidebar",
  workspaceRoot: "/workspace/walle-agent",
  workspaceName: "walle-agent",
  providerProfileId: "provider-1",
  model: "model-1",
  pinned: false,
  archived: false,
  unread: false,
  status: "idle",
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Sidebar", () => {
  it("collapses its shell and fades a fixed-width content layer without unmounting it", () => {
    const view = render(renderSidebar(true));
    const sidebar = screen.getByRole("complementary", {
      name: "Conversation sidebar",
    });
    const content = sidebar.querySelector('[data-slot="sidebar-content"]');

    expect(sidebar).toHaveAttribute("data-state", "open");
    expect(sidebar.className).toContain(
      "transition-[width,transform,border-color,box-shadow]",
    );
    expect(sidebar.className).toContain("motion-reduce:transition-none");
    expect(content).toHaveClass("w-[276px]", "opacity-100", "translate-x-0");

    view.rerender(renderSidebar(false));

    expect(sidebar).toHaveAttribute("data-state", "closed");
    expect(sidebar.className).toContain("min-[861px]:w-0");
    expect(sidebar.className).not.toContain("min-[861px]:hidden");
    expect(content).toHaveClass("opacity-0", "-translate-x-2");
  });

  it("keeps Settings neutral on every page and only darkens it on hover", () => {
    render(renderSidebar(true));

    const settings = screen.getByRole("button", { name: "Open settings" });
    expect(settings).not.toHaveAttribute("aria-current");
    expect(settings).not.toHaveClass("bg-sidebar-accent");
    expect(settings).toHaveClass(
      "hover:bg-sidebar-accent/85",
      "hover:text-sidebar-accent-foreground",
    );

    fireEvent.click(settings);
    expect(handlers.onOpenSettings).toHaveBeenCalledOnce();
  });

  it("overlays search below the header without shifting content and closes with Escape", () => {
    render(renderSidebar(true, { threads: [thread] }));

    const navigation = screen.getByRole("navigation", {
      name: "Walle navigation",
    });
    const searchToggle = screen.getByRole("button", {
      name: "Search conversations",
    });
    expect(searchToggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(searchToggle);

    const search = screen.getByRole("search");
    const input = screen.getByPlaceholderText("Search conversations");
    expect(search).toHaveAttribute("data-slot", "sidebar-search-popover");
    expect(search).toHaveClass("absolute", "top-11", "z-20");
    expect(navigation).toBeVisible();
    expect(input).toHaveFocus();
    expect(searchToggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.change(input, { target: { value: "nothing matches" } });
    expect(
      screen.queryByRole("button", { name: "Improve sidebar" }),
    ).not.toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByRole("search")).not.toBeInTheDocument();
    expect(searchToggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByRole("button", { name: "Improve sidebar" }),
    ).toBeInTheDocument();
  });

  it("renders the Walle brand as static content without hover behavior", () => {
    render(renderSidebar(true));

    const brand = screen
      .getByText("Walle")
      .closest('[data-slot="sidebar-brand"]');
    expect(brand).toBeInTheDocument();
    expect(brand?.tagName).toBe("DIV");
    expect(brand?.className).not.toContain("hover:");
    expect(brand?.closest("button")).toBeNull();
  });

  it("expands and collapses a workspace with an accessible button", () => {
    const view = render(renderSidebar(true, { threads: [thread] }));

    const workspace = screen.getByRole("button", {
      name: "Collapse walle-agent workspace",
    });
    expect(workspace).toHaveAttribute("aria-expanded", "true");
    expect(
      workspace.querySelector(".tabler-icon-folder-open"),
    ).toBeInTheDocument();
    expect(
      workspace.querySelector(".tabler-icon-folder"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Improve sidebar" }),
    ).toBeInTheDocument();
    expect(workspace.parentElement).not.toHaveTextContent("1");

    fireEvent.click(workspace);

    const collapsedWorkspace = screen.getByRole("button", {
      name: "Expand walle-agent workspace",
    });
    expect(collapsedWorkspace).toHaveAttribute("aria-expanded", "false");
    expect(
      collapsedWorkspace.querySelector(".tabler-icon-folder"),
    ).toBeInTheDocument();
    expect(
      collapsedWorkspace.querySelector(".tabler-icon-folder-open"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Improve sidebar" }),
    ).not.toBeInTheDocument();

    view.rerender(
      renderSidebar(true, {
        threads: [{ ...thread, updatedAt: "2026-08-10T01:00:00.000Z" }],
      }),
    );
    expect(
      screen.getByRole("button", { name: "Expand walle-agent workspace" }),
    ).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(
      screen.getByRole("button", { name: "Expand walle-agent workspace" }),
    );
    expect(
      screen.getByRole("button", { name: "Improve sidebar" }),
    ).toBeInTheDocument();
  });

  it("creates a task in the hovered workspace without toggling the group", () => {
    const onCreateInWorkspace = vi.fn(async () => undefined);
    render(
      renderSidebar(true, {
        threads: [thread],
        onCreateInWorkspace,
      }),
    );

    const workspace = screen.getByRole("button", {
      name: "Collapse walle-agent workspace",
    });
    const create = screen.getByRole("button", {
      name: "New task in walle-agent",
    });

    expect(create).toHaveClass(
      "pointer-events-none",
      "opacity-0",
      "group-hover/workspace:pointer-events-auto",
      "group-hover/workspace:opacity-100",
    );
    expect(create).toHaveClass("group-focus-within/workspace:opacity-100");
    fireEvent.click(create);

    expect(onCreateInWorkspace).toHaveBeenCalledOnce();
    expect(onCreateInWorkspace).toHaveBeenCalledWith("/workspace/walle-agent");
    expect(workspace).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("button", { name: "Improve sidebar" }),
    ).toBeInTheDocument();
  });

  it("shows a blue unread dot only for a background thread", () => {
    const view = render(
      renderSidebar(true, {
        threads: [thread],
        unreadThreadIds: [thread.id],
      }),
    );

    const unreadLabel = screen.getByText("Unread");
    const row = unreadLabel.closest("button");
    expect(row?.querySelector('[data-slot="thread-status-dot"]')).toHaveClass(
      "bg-[var(--info)]",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse walle-agent workspace" }),
    );
    const collapsedWorkspace = screen.getByRole("button", {
      name: /Expand walle-agent workspace.*1 unread/,
    });
    expect(
      collapsedWorkspace.querySelector('[data-slot="workspace-unread-dot"]'),
    ).toHaveClass("bg-[var(--info)]");

    view.rerender(
      renderSidebar(true, {
        threads: [thread],
        activeIds: [thread.id],
        unreadThreadIds: [thread.id],
      }),
    );
    expect(screen.queryByText("Unread")).not.toBeInTheDocument();
    expect(
      screen.queryByText("1 unread", { selector: ".sr-only" }),
    ).not.toBeInTheDocument();
  });
});
