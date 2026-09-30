import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ProviderSecretStore,
  type SafeStorageLike,
} from "../provider-secret-store";

class FakeSafeStorage implements SafeStorageLike {
  constructor(private readonly available = true) {}
  isEncryptionAvailable(): boolean {
    return this.available;
  }
  encryptString(value: string): Buffer {
    return Buffer.from([...value].reverse().join(""), "utf8");
  }
  decryptString(value: Buffer): string {
    return [...value.toString("utf8")].reverse().join("");
  }
}

describe("ProviderSecretStore", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "walle-provider-secrets-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("round-trips encrypted values without writing plaintext", async () => {
    const store = new ProviderSecretStore(directory, new FakeSafeStorage());
    await store.init();
    const status = await store.set("provider-1", "sk-super-secret-1234");
    const disk = await readFile(store.filePath, "utf8");

    expect(status).toMatchObject({ hasApiKey: true });
    expect(status.apiKeyHint).not.toContain("super-secret");
    expect(disk).not.toContain("sk-super-secret-1234");
    expect(store.get("provider-1")).toBe("sk-super-secret-1234");
  });

  it("refuses to save plaintext when OS encryption is unavailable", async () => {
    const store = new ProviderSecretStore(
      directory,
      new FakeSafeStorage(false),
    );
    await store.init();
    await expect(store.set("provider-1", "secret")).rejects.toThrow(
      /unavailable/i,
    );
  });

  it("recovers its write queue after a transient disk failure", async () => {
    const store = new ProviderSecretStore(directory, new FakeSafeStorage());
    await store.init();
    await rm(directory, { recursive: true, force: true });
    await expect(store.set("provider-1", "first-secret")).rejects.toThrow();

    await mkdir(directory, { recursive: true });
    await expect(
      store.set("provider-2", "second-secret"),
    ).resolves.toBeDefined();
    expect(store.get("provider-2")).toBe("second-secret");
  });
});
