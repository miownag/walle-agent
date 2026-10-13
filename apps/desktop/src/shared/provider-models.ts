import type { ProviderModel, ProviderProfile } from "./contracts";

export function providerModels(
  profile: Pick<ProviderProfile, "model" | "models">,
): ProviderModel[] {
  return profile.models?.length
    ? profile.models
    : profile.model
      ? [{ label: profile.model, value: profile.model }]
      : [];
}

export function normalizeProviderModels(input: unknown): ProviderModel[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  return input.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = typeof item.value === "string" ? item.value.trim() : "";
    const label = typeof item.label === "string" ? item.label.trim() : "";
    if (!value || seen.has(value)) return [];
    seen.add(value);
    return [
      {
        value,
        label: label || value,
        description:
          typeof item.description === "string" ? item.description.trim() : "",
      },
    ];
  });
}

export function selectedProviderModel(
  profile: ProviderProfile,
  value?: string,
): string {
  const selected = value ?? profile.model;
  if (!providerModels(profile).some((model) => model.value === selected))
    throw new Error(`Unknown model for “${profile.name}”: ${selected}`);
  return selected;
}
