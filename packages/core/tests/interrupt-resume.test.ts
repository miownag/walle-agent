import { describe, it, expect } from "vitest";
import { Agent } from "../src/agent.js";
import type {
  LLMProvider,
  LLMChatRequest,
  LLMChatResponse,
  LLMStreamChunk,
  ModelMessage,
} from "../src/index.js";

// ─── Test doubles ────────────────────────────────────────────────────

class HangingProvider implements LLMProvider {
  name = "hanging";
  public calls: LLMChatRequest[] = [];
  /** Resolves when chat/stream is entered. */
  // NOTE: `resolveStarted` is declared BEFORE `started` on purpose. With
  // `target: ES2022` + `useDefineForClassFields`, class fields are defined in
  // declaration order via Object.defineProperty; if `started` came first its
  // executor would set `this.resolveStarted`, and the subsequent `resolveStarted!`
  // field definition would then overwrite it with `undefined`, causing a
  // "this.resolveStarted is not a function" TypeError at runtime.
  private resolveStarted!: () => void;
  started = new Promise<void>((res) => (this.resolveStarted = res));

  async chat(req: LLMChatRequest): Promise<LLMChatResponse> {
    this.resolveStarted();
    await this.waitForAbort(req.signal);
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  }

  async *stream(request: LLMChatRequest): AsyncIterable<LLMStreamChunk> {
    this.calls.push(request);
    this.resolveStarted();
    // Emit one chunk so the runtime is past its first await,
    // then block until the request is aborted.
    yield { type: "text_delta", content: "hello" };
    await this.waitForAbort(request.signal);
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  }

  private waitForAbort(signal: AbortSignal | undefined): Promise<void> {
    if (!signal) return new Promise(() => void 0); // hang forever if never signalled
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
}

class OneShotProvider implements LLMProvider {
  name = "oneshot";
  calls: LLMChatRequest[] = [];
  constructor(private readonly response: string) {}
  async chat(req: LLMChatRequest): Promise<LLMChatResponse> {
    this.calls.push(req);
    const message: ModelMessage = { role: "assistant", content: this.response };
    return { message };
  }
  async *stream(req: LLMChatRequest): AsyncIterable<LLMStreamChunk> {
    this.calls.push(req);
    yield { type: "text_delta", content: this.response };
    yield {
      type: "message_complete",
      message: { role: "assistant", content: this.response },
    };
  }
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("Agent auto sessionId", () => {
  it("auto-assigns a sessionId when none is given", async () => {
    const agent = await Agent.create({
      name: "test",
      model: new OneShotProvider("hi"),
      useBuiltinTools: false,
    });
    expect(typeof agent.sessionId).toBe("string");
    expect(agent.sessionId.length).toBeGreaterThan(0);
    await agent.dispose();
  });

  it("honours a caller-provided sessionId", async () => {
    const agent = await Agent.create({
      name: "test",
      model: new OneShotProvider("hi"),
      sessionId: "pinned-session",
      useBuiltinTools: false,
    });
    expect(agent.sessionId).toBe("pinned-session");
    await agent.dispose();
  });

  it("threads its sessionId into every run by default (and honours overrides)", async () => {
    const mp = new OneShotProvider("ok");
    const seen: Array<string | undefined> = [];
    const agent = await Agent.create({
      name: "test",
      model: mp,
      sessionId: "sticky",
      useBuiltinTools: false,
      plugins: [
        {
          name: "probe",
          install(ctx) {
            ctx.events.on("collect_messages", ({ sessionId }) => {
              seen.push(sessionId);
            });
          },
        },
      ],
    });

    await agent.run("a");
    await agent.run("b", { sessionId: "override" });

    expect(seen).toEqual(["sticky", "override"]);
    await agent.dispose();
  });
});

describe("Agent.interrupt", () => {
  it("is a no-op when no run is active", async () => {
    const agent = await Agent.create({
      name: "test",
      model: new OneShotProvider("hi"),
      useBuiltinTools: false,
    });
    expect(agent.isRunning).toBe(false);
    expect(() => agent.interrupt()).not.toThrow();
    await agent.dispose();
  });

  it("cancels an in-flight streaming run", async () => {
    const provider = new HangingProvider();
    const agent = await Agent.create({
      name: "test",
      model: provider,
      useBuiltinTools: false,
    });

    const stream = agent.run("long work", { stream: true });
    const events: any[] = [];

    // Start consuming in the background; interrupt once the LLM call has begun.
    const consume = (async () => {
      for await (const ev of stream) {
        process.stderr.write(`[test] event: ${ev.type}\n`);
        events.push(ev);
      }
      process.stderr.write(`[test] consume done\n`);
    })();

    await provider.started;
    process.stderr.write(`[test] provider started, interrupting\n`);
    agent.interrupt("user-ctrl-c");
    process.stderr.write(`[test] interrupt called, awaiting consume\n`);
    await consume;

    const endEvent = events.find((e) => e.type === "run_end");
    expect(endEvent?.status).toBe("user-cancelled");
    expect(agent.isRunning).toBe(false);
    await agent.dispose();
  });
});

describe("Agent concurrent run guard", () => {
  it("rejects a second run while the first is still streaming", async () => {
    const provider = new HangingProvider();
    const agent = await Agent.create({
      name: "test",
      model: provider,
      useBuiltinTools: false,
    });

    // Start a run; iterate it lazily in the background.
    const stream = agent.run("first", { stream: true });
    const consume = (async () => {
      for await (const _ of stream) {
        /* consume */
      }
    })();

    await provider.started;
    expect(agent.isRunning).toBe(true);

    await expect(agent.run("second")).rejects.toThrow(/already running/);

    agent.interrupt();
    await consume;
    await agent.dispose();
  });
});

describe("Agent.dispose interrupts", () => {
  it("interrupts a running stream as part of dispose()", async () => {
    const provider = new HangingProvider();
    const agent = await Agent.create({
      name: "test",
      model: provider,
      useBuiltinTools: false,
    });

    const stream = agent.run("work", { stream: true });
    const events: any[] = [];
    const consume = (async () => {
      for await (const ev of stream) events.push(ev);
    })();

    await provider.started;
    await agent.dispose();
    await consume;

    const endEvent = events.find((e) => e.type === "run_end");
    expect(endEvent?.status).toBe("user-cancelled");
  });
});

describe("Agent.resume (no memory plugin)", () => {
  it("throws when the config does not include a memory plugin", async () => {
    await expect(
      Agent.resume("some-session", {
        name: "test",
        model: new OneShotProvider("hi"),
      } as any),
    ).rejects.toThrow(/MemoryPlugin/);
  });
});
