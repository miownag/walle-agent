import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Switch } from "./switch";

describe("Switch", () => {
  it("darkens only the unchecked hover state and preserves the checked color", () => {
    const onCheckedChange = vi.fn();
    render(
      <Switch
        aria-label="Capability"
        defaultChecked={false}
        onCheckedChange={onCheckedChange}
      />,
    );

    const control = screen.getByRole("switch", { name: "Capability" });
    expect(control.className).toContain(
      "data-unchecked:hover:bg-foreground/30",
    );
    expect(control.className).toContain(
      "dark:data-unchecked:hover:bg-foreground/30",
    );
    expect(control.className).toContain("data-checked:hover:bg-primary");
    expect(control).toHaveAttribute("data-unchecked");

    fireEvent.click(control);

    expect(onCheckedChange.mock.calls[0]?.[0]).toBe(true);
    expect(control).toHaveAttribute("data-checked");
  });
});
