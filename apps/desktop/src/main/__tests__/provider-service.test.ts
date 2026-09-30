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
