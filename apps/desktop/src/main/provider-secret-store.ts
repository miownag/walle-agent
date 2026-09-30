import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

interface SecretRecord {
  encrypted: string;
  hint: string;
  updatedAt: string;
}

interface SecretFile {
  version: 1;
  providers: Record<string, SecretRecord>;
}

export interface ProviderSecretStatus {
  hasApiKey: boolean;
  apiKeyHint?: string;
}

function hintFor(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length <= 8) return "••••••••";
  return `${trimmed.slice(0, 3)}••••${trimmed.slice(-4)}`;
}

export class ProviderSecretStore {
  readonly filePath: string;
  private data: SecretFile = { version: 1, providers: {} };
  private initialized = false;
  private writeQueue = Promise.resolve();

  constructor(
    rootDir: string,
    private readonly storage: SafeStorageLike,
  ) {
    this.filePath = join(rootDir, "provider-secrets.json");
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const raw = JSON.parse(
        await readFile(this.filePath, "utf8"),
      ) as Partial<SecretFile>;
      this.data = {
        version: 1,
        providers:
          raw.providers && typeof raw.providers === "object"
            ? raw.providers
            : {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(
          "Provider secret store is corrupt; refusing to overwrite encrypted credentials",
          { cause: error },
        );
      }
    }
    this.initialized = true;
  }

  async set(providerId: string, apiKey: string): Promise<ProviderSecretStatus> {
    this.assertReady();
    const key = apiKey.trim();
    if (!key) {
      await this.delete(providerId);
      return { hasApiKey: false };
    }
    if (!this.storage.isEncryptionAvailable()) {
      throw new Error(
        "Secure credential storage is unavailable on this system; the API key was not saved",
      );
    }
    this.data.providers[providerId] = {
      encrypted: this.storage.encryptString(key).toString("base64"),
      hint: hintFor(key),
      updatedAt: new Date().toISOString(),
    };
    await this.persist();
    return {
      hasApiKey: true,
      apiKeyHint: this.data.providers[providerId].hint,
    };
  }

  get(providerId: string): string | undefined {
    this.assertReady();
    const record = this.data.providers[providerId];
    if (!record) return undefined;
    if (!this.storage.isEncryptionAvailable()) {
      throw new Error("Secure credential storage is currently unavailable");
    }
    try {
      return this.storage.decryptString(
        Buffer.from(record.encrypted, "base64"),
      );
    } catch (error) {
      throw new Error(
        `Could not decrypt credentials for provider ${providerId}`,
        { cause: error },
      );
    }
  }

  status(providerId: string): ProviderSecretStatus {
    this.assertReady();
    const record = this.data.providers[providerId];
    return record
      ? { hasApiKey: true, apiKeyHint: record.hint }
      : { hasApiKey: false };
  }

  async delete(providerId: string): Promise<void> {
    this.assertReady();
    if (!(providerId in this.data.providers)) return;
    delete this.data.providers[providerId];
    await this.persist();
  }

  private assertReady(): void {
    if (!this.initialized)
      throw new Error("ProviderSecretStore.init() must be called first");
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2) + "\n";
    const operation = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, this.filePath);
      });
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }
}
