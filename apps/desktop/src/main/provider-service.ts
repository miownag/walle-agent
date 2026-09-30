import { randomUUID } from "node:crypto";
import { AnthropicProvider } from "@walle-agent/anthropic";
import type { LLMProvider } from "@walle-agent/core";
import { OpenAIProvider } from "@walle-agent/openai";
import type {
  AppSettings,
  ProviderProfile,
  ProviderProfileInput,
} from "../shared/contracts";
import { DesktopStore } from "./desktop-store";
import { ProviderSecretStore } from "./provider-secret-store";

function environmentKey(kind: ProviderProfile["kind"]): string | undefined {
  if (kind === "anthropic") return process.env.ANTHROPIC_API_KEY;
  if (kind === "openai") return process.env.OPENAI_API_KEY;
  // Never forward a generic vendor credential to a user-controlled endpoint.
  return undefined;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    host === "::1"
  )
    return true;
  const parts = host.split(".").map(Number);
  return (
    parts.length === 4 && parts.every(Number.isInteger) && parts[0] === 127
  );
}

export class ProviderService {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: DesktopStore,
    private readonly secrets: ProviderSecretStore,
  ) {}

  settingsForRenderer(): AppSettings {
    const settings = this.store.getSettings();
    settings.providers = settings.providers.map((profile) => {
      const status = this.secrets.status(profile.id);
      const env = environmentKey(profile.kind);
      return {
        ...profile,
        hasApiKey: status.hasApiKey || Boolean(env),
        apiKeyHint:
          status.apiKeyHint ?? (env ? "Environment variable" : undefined),
      };
    });
    return settings;
  }

  upsert(input: ProviderProfileInput): Promise<AppSettings> {
    return this.serializeMutation(() => this.upsertUnlocked(input));
  }

  private async upsertUnlocked(
    input: ProviderProfileInput,
  ): Promise<AppSettings> {
    const name = input.name.trim();
    const model = input.model.trim();
    if (!name || !model)
      throw new Error("Provider name and model are required");
    if (input.kind === "openai-compatible") {
      if (!input.baseUrl?.trim())
        throw new Error("An OpenAI-compatible provider requires a base URL");
      const url = new URL(input.baseUrl);
      if (!["http:", "https:"].includes(url.protocol))
        throw new Error("Provider base URL must use HTTP or HTTPS");
      if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
        throw new Error(
          "Remote provider base URLs must use HTTPS; HTTP is only allowed for loopback endpoints",
        );
      }
    }

    const settings = this.store.getSettings();
    const id = input.id || randomUUID();
    const existing = settings.providers.find((provider) => provider.id === id);
    if (input.id && !existing)
      throw new Error(`Unknown provider profile: ${input.id}`);

    if (Object.prototype.hasOwnProperty.call(input, "apiKey")) {
      await this.secrets.set(id, input.apiKey ?? "");
    }
    const secretStatus = this.secrets.status(id);
    const profile: ProviderProfile = {
      id,
      name,
      kind: input.kind,
      model,
      baseUrl: input.baseUrl?.trim() || undefined,
      hasApiKey: secretStatus.hasApiKey,
      apiKeyHint: secretStatus.apiKeyHint,
      isDefault:
        input.isDefault ??
        existing?.isDefault ??
        settings.providers.length === 0,
    };
    const providers = settings.providers.filter(
      (provider) => provider.id !== id,
    );
    providers.push(profile);
    const selectedDefault = profile.isDefault
      ? id
      : (providers.find((provider) => provider.isDefault)?.id ?? id);
    for (const provider of providers)
      provider.isDefault = provider.id === selectedDefault;
    await this.store.updateSettings({ providers });
    for (const thread of this.store.listThreads()) {
      if (thread.providerProfileId === id && thread.model !== profile.model) {
        await this.store.updateThread(thread.id, { model: profile.model });
      }
    }
    return this.settingsForRenderer();
  }

  delete(providerId: string): Promise<AppSettings> {
    return this.serializeMutation(() => this.deleteUnlocked(providerId));
  }

  private async deleteUnlocked(providerId: string): Promise<AppSettings> {
    const settings = this.store.getSettings();
    const providers = settings.providers.filter(
      (provider) => provider.id !== providerId,
    );
    if (providers.length === settings.providers.length)
      throw new Error(`Unknown provider profile: ${providerId}`);
    if (providers.length && !providers.some((provider) => provider.isDefault))
      providers[0].isDefault = true;
    await this.secrets.delete(providerId);
    await this.store.updateSettings({ providers });
    const fallback =
      providers.find((provider) => provider.isDefault) ?? providers[0];
    for (const thread of this.store.listThreads()) {
      if (thread.providerProfileId === providerId) {
        await this.store.updateThread(thread.id, {
          providerProfileId: fallback?.id ?? "",
        });
      }
    }
    return this.settingsForRenderer();
  }

  resolveProfile(profileId?: string): ProviderProfile {
    const settings = this.store.getSettings();
    const profile = profileId
      ? settings.providers.find((entry) => entry.id === profileId)
      : settings.providers.find((entry) => entry.isDefault);
    if (profileId && !profile)
      throw new Error(`Unknown provider profile: ${profileId}`);
    if (!profile)
      throw new Error("Configure an AI provider before starting a task");
    return profile;
  }

  createModel(profileId?: string): {
    profile: ProviderProfile;
    model: LLMProvider;
  } {
    const profile = this.resolveProfile(profileId);
    const apiKey = this.secrets.get(profile.id) ?? environmentKey(profile.kind);
    if (!apiKey)
      throw new Error(
        `Add an API key for “${profile.name}” before starting a task`,
      );
    if (profile.kind === "anthropic") {
      return {
        profile,
        model: new AnthropicProvider({
          apiKey,
          model: profile.model,
          defaultMaxTokens: 16_384,
        }),
      };
    }
    return {
      profile,
      model: new OpenAIProvider({
        apiKey,
        model: profile.model,
        baseURL:
          profile.kind === "openai-compatible" ? profile.baseUrl : undefined,
      }),
    };
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.catch(() => undefined).then(operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
