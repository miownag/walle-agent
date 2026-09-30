import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ThreadSplitLayout } from "@/components/layout/thread-split-layout";
import { Composer } from "@/components/thread/composer";
import { TooltipProvider } from "@/components/ui/tooltip";
import type {
  PermissionMode,
  ProviderProfile,
  ThreadRecord,
} from "@shared/contracts";
import { Titlebar } from "./titlebar";

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
  Object.defineProperty(window, "PointerEvent", {
    configurable: true,
    value: MouseEvent,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 1_000,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => 600,
  });
  Element.prototype.setPointerCapture ??= vi.fn();
  Element.prototype.releasePointerCapture ??= vi.fn();
  Element.prototype.hasPointerCapture ??= () => false;
});

const providers: ProviderProfile[] = [
  {
    id: "provider-a",
    name: "Provider A",
    kind: "openai",
    model: "model-a",
    hasApiKey: true,
    isDefault: true,
  },
  {
    id: "provider-b",
    name: "Provider B",
    kind: "anthropic",
    model: "model-b",
    hasApiKey: true,
    isDefault: false,
  },
];

const threads: ThreadRecord[] = [
  {
    id: "thread-one",
    sessionId: "session-one",
    title: "First thread",
    workspaceRoot: "/repo",
    workspaceName: "repo",
    providerProfileId: "provider-a",
    model: "model-a",
    pinned: false,
    archived: false,
    unread: false,
    status: "idle",
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
  },
  {
    id: "thread-two",
    sessionId: "session-two",
    title: "Second thread",
    workspaceRoot: "/repo",
    workspaceName: "repo",
    providerProfileId: "provider-a",
    model: "model-a",
    pinned: false,
    archived: false,
    unread: false,
    status: "idle",
    createdAt: "2026-08-10T00:00:01.000Z",
    updatedAt: "2026-08-10T00:00:01.000Z",
  },
];

function MenuHarness() {
  const [paneIds, setPaneIds] = useState([threads[0].id]);
  const [providerId, setProviderId] = useState(threads[0].providerProfileId);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("ask");
  const activeThread = { ...threads[0], providerProfileId: providerId };
  return (
    <TooltipProvider>
      <div className="h-[700px] w-[1100px]">
        <Titlebar
          activeThread={activeThread}
          threads={threads}
          paneIds={paneIds}
          dockOpen={false}
          sidebarOpen
          onToggleSidebar={() => undefined}
          onAddSplit={(threadId) =>
            setPaneIds((current) => [...current, threadId])
          }
          onToggleDock={() => undefined}
        />
        <div className="h-[400px]">
          {paneIds.length === 2 ? (
            <ThreadSplitLayout
              primaryId={paneIds[0]}
              secondaryId={paneIds[1]}
              primary={
                <section aria-label="First conversation">First pane</section>
              }
              secondary={
                <section aria-label="Second conversation">Second pane</section>
              }
            />
          ) : (
            <section aria-label="First conversation">Single pane</section>
          )}
        </div>
        <Composer
          thread={activeThread}
          providers={providers}
          permissionMode={permissionMode}
          maxContextTokens={128_000}
          running={false}
          focused={false}
          onSend={async () => undefined}
          onStop={async () => undefined}
          onSlashCommand={async () => undefined}
          onProviderChange={async (nextProviderId) =>
            setProviderId(nextProviderId)
          }
          onPermissionModeChange={async (mode) => setPermissionMode(mode)}
        />
        <output data-testid="selected-provider">{providerId}</output>
        <output data-testid="selected-permission-mode">{permissionMode}</output>
      </div>
    </TooltipProvider>
  );
}

describe("Base UI grouped dropdown integration", () => {
  it("opens split/provider menus and selects a second thread without crashing", async () => {
    render(<MenuHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Split conversation" }));
    expect(await screen.findByText("Open side by side")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Second thread"));

    await waitFor(() => {
      expect(screen.getByLabelText("First conversation")).toHaveTextContent(
        "First pane",
      );
      expect(screen.getByLabelText("Second conversation")).toHaveTextContent(
        "Second pane",
      );
    });

    fireEvent.click(screen.getByRole("button", { name: /model-a/i }));
    expect(await screen.findByText("Provider & model")).toBeInTheDocument();
    fireEvent.click(screen.getByText("model-b"));
    await waitFor(() =>
      expect(screen.getByTestId("selected-provider")).toHaveTextContent(
        "provider-b",
      ),
    );
  });

  it("selects the approval policy through the real Base UI radio menu", async () => {
    render(<MenuHarness />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Select approval policy, current Ask before actions",
      }),
    );

    expect(await screen.findByText("Approval policy")).toBeInTheDocument();
    expect(
      screen.getByRole("menuitemradio", { name: "Ask before actions" }),
    ).toHaveAttribute("aria-checked", "true");

    fireEvent.click(
      screen.getByRole("menuitemradio", { name: "Deny high-risk" }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("selected-permission-mode")).toHaveTextContent(
        "deny-high-risk",
      );
      expect(
        screen.getByRole("button", {
          name: "Select approval policy, current Deny high-risk",
        }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("menuitemradio", { name: "Deny high-risk" }),
      ).not.toBeInTheDocument();
    });
  });

  it("uses large, directionless panel icons and exposes sidebar state", () => {
    const onToggleSidebar = vi.fn();
    const { container } = render(
      <TooltipProvider>
        <Titlebar
          activeThread={threads[0]}
          threads={threads}
          paneIds={[threads[0].id]}
          dockOpen={false}
          sidebarOpen
          onToggleSidebar={onToggleSidebar}
          onAddSplit={() => undefined}
          onToggleDock={() => undefined}
        />
      </TooltipProvider>,
    );

    const toggle = screen.getByRole("button", { name: "Toggle sidebar" });
    const dockToggle = screen.getByRole("button", {
      name: "Open developer dock",
    });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle.querySelector(".tabler-icon-layout-sidebar")).toHaveClass(
      "size-5",
    );
    expect(
      dockToggle.querySelector(".tabler-icon-layout-sidebar-right"),
    ).toHaveClass("size-5");
    expect(
      container.querySelector('[class*="sidebar-left-collapse"]'),
    ).not.toBeInTheDocument();
    expect(
      container.querySelector('[class*="sidebar-right-expand"]'),
    ).not.toBeInTheDocument();
    expect(container.querySelector("header")?.className).toContain(
      "grid-template-columns",
    );
    expect(container.querySelector("header")).not.toHaveClass("border-b");
    expect(
      container.querySelector('[data-slot="titlebar-sidebar-controls"]'),
    ).not.toHaveClass("border-b", "walle-divider-bottom");
    expect(container.querySelector('[data-slot="titlebar-main"]')).toHaveClass(
      "border-b",
      "walle-divider-bottom",
    );
    expect(container.querySelector("header")?.className).toContain(
      "grid-cols-[276px_minmax(0,1fr)]",
    );
    expect(toggle.parentElement?.className).toContain("pl-[92px]");
    expect(toggle.className).not.toContain("translate-y");
    expect(dockToggle.className).not.toContain("translate-y");
    expect(container.querySelector("header")?.className).toContain(
      "motion-reduce:transition-none",
    );

    fireEvent.click(toggle);
    expect(onToggleSidebar).toHaveBeenCalledOnce();
  });

  it("keeps a traffic-light-safe leading gutter while the sidebar is closed", () => {
    const { container } = render(
      <TooltipProvider>
        <Titlebar
          activeThread={threads[0]}
          threads={threads}
          paneIds={[threads[0].id]}
          dockOpen={false}
          sidebarOpen={false}
          onToggleSidebar={() => undefined}
          onAddSplit={() => undefined}
          onToggleDock={() => undefined}
        />
      </TooltipProvider>,
    );

    expect(container.querySelector("header")?.className).toContain(
      "grid-cols-[128px_minmax(0,1fr)]",
    );
    expect(
      screen.getByRole("button", { name: "Toggle sidebar" }).parentElement
        ?.className,
    ).toContain("pl-[92px]");
  });

  it("uses the titlebar as Settings context without conversation actions", () => {
    const { container } = render(
      <TooltipProvider>
        <Titlebar
          page="settings"
          activeThread={threads[0]}
          threads={threads}
          paneIds={[threads[0].id]}
          dockOpen
          sidebarOpen
          onToggleSidebar={() => undefined}
          onAddSplit={() => undefined}
          onToggleDock={() => undefined}
        />
      </TooltipProvider>,
    );

    expect(container.querySelector("header")).toHaveAttribute(
      "data-page",
      "settings",
    );
    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Split conversation" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Close developer dock" }),
    ).not.toBeInTheDocument();
  });
});
