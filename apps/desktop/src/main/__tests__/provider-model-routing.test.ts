import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { DesktopStore } from "../desktop-store";
import { ProviderSecretStore } from "../provider-secret-store";
import { ProviderService } from "../provider-service";

it("sends the selected model value to the configured Anthropic endpoint", async () => {
  let received: { model?: string; key?: string | string[] } = {};
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    received = { model: input.model, key: req.headers["x-api-key"] };
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: input.model,
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No server address");
  const root = await mkdtemp(join(tmpdir(), "walle-model-route-"));
  vi.stubGlobal("window", undefined);
  const oldUrl = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";
  try {
    const store = new DesktopStore(root);
    const secrets = new ProviderSecretStore(root, {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString(),
    });
    await Promise.all([store.init(), secrets.init()]);
    const service = new ProviderService(store, secrets);
    const settings = await service.upsert({
      name: "Gateway",
      kind: "anthropic",
      model: "default-model",
      models: [
        { value: "default-model" },
        { label: "Friendly name", value: "selected-model" },
      ],
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: "ferry",
    });
    const { model } = service.createModel(
      settings.providers[0].id,
      "selected-model",
    );
    await model.chat({ messages: [{ role: "user", content: "hello" }] });
    expect(received).toEqual({ model: "selected-model", key: "ferry" });
  } finally {
    vi.unstubAllGlobals();
    if (oldUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = oldUrl;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
