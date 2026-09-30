import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { UserTurnNavigator, type UserTurnAnchor } from "./user-turn-navigator";

const turns: UserTurnAnchor[] = [
  { id: "turn-1", label: "Set up the workspace", active: false },
  { id: "turn-2", label: "Refine the navigation", active: true },
  { id: "turn-3", label: "Polish the empty state", active: false },
];

function renderNavigator(items = turns, onSelect = vi.fn()) {
  return {
    onSelect,
    ...render(
      <TooltipProvider>
        <UserTurnNavigator turns={items} onSelect={onSelect} />
      </TooltipProvider>,
    ),
  };
}

describe("UserTurnNavigator", () => {
  it("marks the current turn and selects a message from the rail", () => {
    const { onSelect } = renderNavigator();
    const active = screen.getByRole("button", {
      name: "Jump to message 2: Refine the navigation",
    });

    expect(active).toHaveAttribute("aria-current", "location");
    fireEvent.click(active);
    expect(onSelect).toHaveBeenCalledWith("turn-2");
  });

  it("supports arrow and boundary key navigation", () => {
    renderNavigator();
    const first = screen.getByRole("button", {
      name: "Jump to message 1: Set up the workspace",
    });
    const second = screen.getByRole("button", {
      name: "Jump to message 2: Refine the navigation",
    });
    const last = screen.getByRole("button", {
      name: "Jump to message 3: Polish the empty state",
    });

    fireEvent.focus(first);
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(second).toHaveFocus();

    fireEvent.keyDown(second, { key: "End" });
    expect(last).toHaveFocus();
  });

  it("uses a denser scroll rail for long conversations", () => {
    const longConversation = Array.from({ length: 40 }, (_, index) => ({
      id: `turn-${index}`,
      label: `Message ${index}`,
      active: index === 30,
    }));

    renderNavigator(longConversation);

    expect(
      screen.getByRole("navigation", { name: "User message navigation" }),
    ).toHaveAttribute("data-density", "dense");
  });
});
