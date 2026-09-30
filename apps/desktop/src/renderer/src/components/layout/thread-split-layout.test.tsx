import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";

import { ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ThreadSplitLayout } from "./thread-split-layout";

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
    get: () => 1_000,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => 600,
  });
});

function SplitHarness() {
  const [split, setSplit] = useState(false);
  return (
    <div className="h-[600px] w-[1000px]">
      <button type="button" onClick={() => setSplit(true)}>
        Split conversation
      </button>
      <div className="h-[560px]">
        <ResizablePanelGroup
          id="outer-conversation-layout"
          orientation="horizontal"
          defaultLayout={{ workspace: 100 }}
        >
          <ResizablePanel id="workspace">
            {split ? (
              <ThreadSplitLayout
                primaryId="thread-one"
                secondaryId="thread-two"
                primary={
                  <section aria-label="First conversation">First pane</section>
                }
                secondary={
                  <section aria-label="Second conversation">
                    Second pane
                  </section>
                }
              />
            ) : (
              <section aria-label="First conversation">Single pane</section>
            )}
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}

describe("ThreadSplitLayout", () => {
  it("can replace a mounted single pane with two registered v4 panels", async () => {
    render(<SplitHarness />);
    expect(screen.getByText("Single pane")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Split conversation" }));

    await waitFor(() => {
      expect(screen.getByLabelText("First conversation")).toHaveTextContent(
        "First pane",
      );
      expect(screen.getByLabelText("Second conversation")).toHaveTextContent(
        "Second pane",
      );
    });

    const group = screen.getByTestId("thread-split-thread-one-thread-two");
    expect(group.children).toHaveLength(3);
    expect(group.children[0]).toHaveAttribute("data-panel");
    expect(group.children[1]).toHaveAttribute("data-separator");
    expect(group.children[1]).toHaveClass("walle-resizable-divider");
    expect(group.children[2]).toHaveAttribute("data-panel");
  });
});
