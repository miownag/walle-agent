import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { EvolutionProposalSummary } from "@shared/contracts";
import { EvolutionInbox } from "./evolution-inbox";

const pendingProposal: EvolutionProposalSummary = {
  id: "proposal-pending",
  type: "skill",
  reason: "task_review",
  status: "pending",
  title: "Reuse the workspace test workflow",
  content: "Run the focused test before the full desktop suite.",
  confidence: 0.91,
  createdAt: "2026-08-10T08:00:00.000Z",
  sessionId: "session-one",
};

const appliedProposal: EvolutionProposalSummary = {
  id: "proposal-applied",
  type: "memory",
  reason: "explicit_remember",
  status: "applied",
  title: "Prefer compact UI copy",
  content: "Keep desktop labels short and direct.",
  confidence: 0.84,
  createdAt: "2026-08-09T08:00:00.000Z",
  sessionId: "session-one",
};

const rejectedProposal: EvolutionProposalSummary = {
  id: "proposal-rejected",
  type: "skill",
  reason: "periodic_review",
  status: "rejected",
  title: "Always skip verification",
  content: "Do not run tests after edits.",
  createdAt: "2026-08-08T08:00:00.000Z",
  sessionId: "session-one",
};

function renderInbox(
  proposals = [pendingProposal, appliedProposal, rejectedProposal],
  loading = false,
) {
  const onBack = vi.fn();
  const onRefresh = vi.fn().mockResolvedValue(undefined);
  const onResolve = vi.fn().mockResolvedValue(undefined);

  render(
    <EvolutionInbox
      proposals={proposals}
      loading={loading}
      onBack={onBack}
      onRefresh={onRefresh}
      onResolve={onResolve}
    />,
  );

  return { onBack, onRefresh, onResolve };
}

describe("EvolutionInbox", () => {
  it("renders as a full page and filters proposals by real status", () => {
    const { onBack, onRefresh } = renderInbox();

    expect(
      screen.getByRole("region", { name: "Evolution inbox" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Evolution inbox" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Proposals stored locally")).toBeInTheDocument();
    expect(
      screen.getByText(/Reviews send recent conversation and tool context/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Reuse the workspace test workflow"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Prefer compact UI copy"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Approved/ }));
    expect(screen.getByText("Prefer compact UI copy")).toBeInTheDocument();
    expect(
      screen.queryByText("Reuse the workspace test workflow"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Rejected/ }));
    expect(screen.getByText("Always skip verification")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh proposals" }));
    expect(onRefresh).toHaveBeenCalledOnce();

    fireEvent.click(
      screen.getByRole("button", { name: "Back to conversations" }),
    );
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("keeps approval and rejection actions connected to the proposal", async () => {
    const { onResolve } = renderInbox([pendingProposal]);

    fireEvent.click(screen.getByRole("button", { name: "Approve & apply" }));
    await waitFor(() => {
      expect(onResolve).toHaveBeenCalledWith(pendingProposal, "approve");
    });

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => {
      expect(onResolve).toHaveBeenCalledWith(pendingProposal, "reject");
    });
  });

  it("shows a calm status-specific empty state", () => {
    renderInbox([]);

    expect(
      screen.getByRole("heading", { name: "You’re caught up" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Approved/ }));
    expect(
      screen.getByRole("heading", { name: "Nothing approved yet" }),
    ).toBeInTheDocument();
  });
});
