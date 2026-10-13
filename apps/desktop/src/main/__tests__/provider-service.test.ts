import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopStore } from "../desktop-store";
import {
  ProviderSecretStore,
  type SafeStorageLike,
} from "../provider-secret-store";
import { ProviderService } from "../provider-service";

const roots: string[] = [];

const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, "utf8"),
  decryptString: (value) => value.toString("utf8"),
};

async function service(): Promise<ProviderService> {
  const root = await mkdtemp(join(tmpdir(), "walle-provider-service-"));
  roots.push(root);
  const store = new DesktopStore(root);
  const secrets = new ProviderSecretStore(root, fakeSafeStorage);
  await Promise.all([store.init(), secrets.init()]);
  return new ProviderService(store, secrets);
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ProviderService endpoint credential boundaries", () => {
  it("accepts optional labels, rejects duplicate model values, and validates the default", async () => {
    const providers = await service();
    const input = {
      name: "Ferry",
      kind: "anthropic" as const,
      model: "one",
      baseUrl: "http://127.0.0.1:8790",
      apiKey: "ferry",
      models: [
        { value: "one" },
        { label: "Second", value: "two", description: "Quick responses" },
      ],
    };
    const settings = await providers.upsert(input);
    expect(settings.providers[0].models).toEqual([
      { label: "one", value: "one", description: "" },
      { label: "Second", value: "two", description: "Quick responses" },
    ]);
    await expect(
      providers.upsert({
        ...input,
        models: [{ value: "one" }, { value: "one" }],
      }),
    ).rejects.toThrow(/unique/);
    await expect(
      providers.upsert({ ...input, model: "missing" }),
    ).rejects.toThrow(/Default model/);
  });

  it("does not forward the Anthropic environment key to a custom endpoint", async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "vendor-secret";
    try {
      const providers = await service();
      const settings = await providers.upsert({
        name: "Gateway",
        kind: "anthropic",
        model: "one",
        baseUrl: "http://127.0.0.1:8790",
      });
      expect(settings.providers[0].hasApiKey).toBe(false);
      expect(() => providers.createModel(settings.providers[0].id)).toThrow(
        /Add an API key/,
      );
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it("never offers the generic OpenAI environment key to compatible endpoints", async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "real-openai-secret";
    try {
      const providers = await service();
      const settings = await providers.upsert({
        name: "Compatible",
        kind: "openai-compatible",
        model: "custom-model",
        baseUrl: "https://models.example.test/v1",
      });
      expect(settings.providers[0]?.hasApiKey).toBe(false);
      expect(() => providers.createModel(settings.providers[0]?.id)).toThrow(
        /Add an API key/,
      );
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it("only permits plaintext compatible endpoints on loopback", async () => {
    const providers = await service();
    await expect(
      providers.upsert({
        name: "Unsafe remote",
        kind: "openai-compatible",
        model: "custom-model",
        baseUrl: "http://models.example.test/v1",
      }),
    ).rejects.toThrow(/must use HTTPS/);
    await expect(
      providers.upsert({
        name: "Local runtime",
        kind: "openai-compatible",
        model: "local-model",
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "local-only",
      }),
    ).resolves.toBeDefined();
  });

  it("serializes concurrent profile mutations without losing either profile", async () => {
    const providers = await service();
    await Promise.all([
      providers.upsert({
        name: "First",
        kind: "openai",
        model: "first-model",
        apiKey: "first-key",
      }),
      providers.upsert({
        name: "Second",
        kind: "anthropic",
        model: "second-model",
        apiKey: "second-key",
      }),
    ]);

    expect(
      providers
        .settingsForRenderer()
        .providers.map((profile) => profile.name)
        .sort(),
    ).toEqual(["First", "Second"]);
  });
});

it("preserves provider positions across edits and default changes", async () => {
  const providers = await service();
  const first = (
    await providers.upsert({ name: "First", kind: "anthropic", model: "one" })
  ).providers[0];
  const secondSettings = await providers.upsert({
    name: "Second",
    kind: "anthropic",
    model: "two",
  });
  const second = secondSettings.providers[1];
  const updated = await providers.upsert({
    id: first.id,
    name: "Renamed",
    kind: "anthropic",
    model: "updated",
    isDefault: true,
  });
  expect(updated.providers.map((provider) => provider.id)).toEqual([
    first.id,
    second.id,
  ]);
  expect(updated.providers[0]).toMatchObject({
    name: "Renamed",
    model: "updated",
    isDefault: true,
  });
  const switched = await providers.upsert({
    id: second.id,
    name: "Second",
    kind: "anthropic",
    model: "two",
    isDefault: true,
  });
  expect(switched.providers.map((provider) => provider.id)).toEqual([
    second.id,
    first.id,
  ]);
  expect(switched.providers.map((provider) => provider.isDefault)).toEqual([
    true,
    false,
  ]);
});
