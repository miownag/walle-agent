import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "../../../../main/defaults";
import type { DesktopApi } from "@shared/contracts";
import { SettingsPage } from "./settings-page";

function renderSettingsPage() {
  const onBack = vi.fn();
  const onUpsertProvider = vi.fn().mockResolvedValue(true);
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
      onUpsertProvider={onUpsertProvider}
      onDeleteProvider={vi.fn().mockResolvedValue(true)}
    />,
  );

  return { onBack, onPatch, onUpsertProvider };
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

  it("saves multiple model values with optional labels and descriptions", async () => {
    const { onUpsertProvider } = renderSettingsPage();
    fireEvent.click(screen.getByRole("button", { name: "Providers" }));
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Gateway" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Model 1 value" }), {
      target: { value: "first-id" },
    });
    expect(
      screen.getByRole("combobox", { name: /Provider type/ }),
    ).toHaveTextContent("OpenAI");
    expect(
      screen.getByRole("combobox", { name: "Default model" }),
    ).toHaveTextContent("first-id");
    fireEvent.change(screen.getByRole("textbox", { name: "Model 1 label" }), {
      target: { value: "Default display name" },
    });
    expect(
      screen.getByRole("combobox", { name: "Default model" }),
    ).toHaveTextContent("Default display name");
    fireEvent.click(screen.getByRole("button", { name: "Add model" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Model 2 label" }), {
      target: { value: "Fast model" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Model 2 value" }), {
      target: { value: "second-id" },
    });
    fireEvent.change(
      screen.getByRole("textbox", { name: "Model 2 description" }),
      { target: { value: "Quick responses" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));
    await waitFor(() =>
      expect(onUpsertProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "first-id",
          models: [
            {
              label: "Default display name",
              value: "first-id",
              description: "",
            },
            {
              label: "Fast model",
              value: "second-id",
              description: "Quick responses",
            },
          ],
        }),
      ),
    );
  });

  it("shows labels in sandbox and permission selectors before opening their menus", () => {
    renderSettingsPage();
    fireEvent.click(
      screen.getByRole("button", { name: "Sandbox & permissions" }),
    );
    const selectedLabels = screen
      .getAllByRole("combobox")
      .map((element) => element.textContent);
    expect(selectedLabels).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Local process"),
        expect.stringContaining("Ask before actions"),
      ]),
    );
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
