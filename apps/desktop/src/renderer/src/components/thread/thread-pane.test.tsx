import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { UserTimelineItem } from "@shared/contracts";
import { UserMessageContent } from "./thread-pane";

function item(
  content: string,
  parts?: UserTimelineItem["parts"],
): UserTimelineItem {
  return {
    id: "user-message",
    type: "user",
    content,
    parts,
    createdAt: "2026-08-10T00:00:00.000Z",
  };
}

describe("UserMessageContent", () => {
  it("renders structured file references as atomic chips in message order", () => {
    const { container } = render(
      <UserMessageContent
        item={item("Review @[src/agent.ts] carefully", [
          { type: "text", text: "Review " },
          {
            type: "file",
            name: "agent.ts",
            relativePath: "src/agent.ts",
          },
          { type: "text", text: " carefully" },
        ])}
      />,
    );

    const chip = screen.getByLabelText("Referenced file src/agent.ts");
    expect(chip).toHaveAttribute("data-relative-path", "src/agent.ts");
    expect(container).toHaveTextContent("Review src/agent.ts carefully");
  });

  it("falls back to readable plain text for legacy timeline items", () => {
    render(<UserMessageContent item={item("Legacy @[src/agent.ts]")} />);

    expect(screen.getByText("Legacy @[src/agent.ts]")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Referenced file src/agent.ts"),
    ).not.toBeInTheDocument();
  });
});
