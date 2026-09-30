import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "../../../../main/defaults";
import type { DesktopApi } from "@shared/contracts";
import { SettingsPage } from "./settings-page";

function renderSettingsPage() {
  const onBack = vi.fn();
  const onPatch = vi.fn().mockResolvedValue(undefined);
  const api = {
    listSkills: vi.fn().mockResolvedValue([]),
  } as unknown as DesktopApi;

  render(
    <SettingsPage
      settings={structuredClone(DEFAULT_SETTINGS)}
      capabilities={[]}
      appVersion="0.1.0"
      platform="darwin"
      api={api}
      saving={false}
      onBack={onBack}
      onPatch={onPatch}
      onUpsertProvider={vi.fn().mockResolvedValue(true)}
      onDeleteProvider={vi.fn().mockResolvedValue(true)}
    />,
  );

  return { onBack, onPatch };
}

describe("SettingsPage", () => {
  it("renders as an in-app page, navigates sections, and returns to conversations", () => {
    const { onBack } = renderSettingsPage();

    expect(
      screen.getByRole("region", { name: "Walle settings" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Appearance" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Providers" }));
    expect(
      screen.getByRole("heading", { name: "Providers" }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Back to conversations" }),
    );
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("keeps setting mutations wired on the page", async () => {
    const { onPatch } = renderSettingsPage();

    fireEvent.click(screen.getByRole("switch", { name: "Reduce motion" }));
    await waitFor(() => {
      expect(onPatch).toHaveBeenCalledWith({
        appearance: { reduceMotion: true },
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Providers" }));
  });
});
