/**
 * Tests for the built-in `web_fetch` tool.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createWebFetchTool,
  htmlToMarkdown,
  clearWebFetchCache,
  WEB_FETCH_NAME,
} from "../src/builtin-tools/web-fetch-tool.js";
import type {
  LLMProvider,
  LLMChatRequest,
  LLMChatResponse,
} from "../src/llm-provider.js";
import type { Agent } from "../src/agent.js";

// ─── Stubs ────────────────────────────────────────────────────────

class StubProvider implements LLMProvider {
  name = "stub";
  public received: LLMChatRequest[] = [];
  constructor(private answer: string = "answered") {}
  async chat(req: LLMChatRequest): Promise<LLMChatResponse> {
    this.received.push(req);
    return {
      message: { role: "assistant", content: this.answer },
    };
  }
  async *stream(): AsyncIterable<never> {
    // not used by web_fetch
  }
}

function mockResponse(init: {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
}): Response {
  const headers = new Headers(init.headers);
  return new Response(init.body ?? "", {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers,
  });
}

function makeFetchImpl(
  routes: Record<string, () => Response | Promise<Response>>,
): typeof fetch {
  return ((url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    const handler = routes[u];
    if (!handler) {
      return Promise.reject(new Error(`Unexpected fetch URL in test: ${u}`));
    }
    return Promise.resolve(handler());
  }) as unknown as typeof fetch;
}

// Minimal agent stub — `web_fetch` only reads `ctx.signal`, never `ctx.agent`.
const agentStub = {} as unknown as Agent;

// ─── htmlToMarkdown ────────────────────────────────────────────────

describe("htmlToMarkdown", () => {
  it("preserves the page title as a top-level heading", () => {
    const md = htmlToMarkdown("<html><head><title>Hello</title></head><body><p>Hi</p></body></html>");
    expect(md).toContain("# Hello");
    expect(md).toContain("Hi");
  });

  it("drops <script> and <style> blocks entirely", () => {
    const md = htmlToMarkdown(
      "<html><body><script>alert(1)</script><style>.a{}</style><p>visible</p></body></html>",
    );
    expect(md).not.toContain("alert");
    expect(md).not.toContain(".a{}");
    expect(md).toContain("visible");
  });

  it("converts headings, links, and lists", () => {
    const md = htmlToMarkdown(
      `<h2>Section</h2>
       <p>Read the <a href="https://example.com">docs</a>.</p>
       <ul><li>One</li><li>Two</li></ul>`,
    );
    expect(md).toContain("## Section");
    expect(md).toContain("[docs](https://example.com)");
    expect(md).toMatch(/- One/);
    expect(md).toMatch(/- Two/);
  });

  it("decodes HTML entities", () => {
    const md = htmlToMarkdown("<p>5 &lt; 10 &amp; you</p>");
    expect(md).toContain("5 < 10 & you");
  });
});

// ─── tool definition ──────────────────────────────────────────────

describe("createWebFetchTool", () => {
  beforeEach(() => clearWebFetchCache());

  it("registers under the canonical name with builtin tag", () => {
    const tool = createWebFetchTool({
      model: new StubProvider(),
      fetchImpl: makeFetchImpl({}),
    });
    expect(tool.name).toBe(WEB_FETCH_NAME);
    expect(tool.tags).toContain("builtin");
    expect(tool.parameters.required).toEqual(["url", "prompt"]);
  });

  it("validates required input fields", async () => {
    const tool = createWebFetchTool({
      model: new StubProvider(),
      fetchImpl: makeFetchImpl({}),
    });
    const r1 = await tool.execute(
      { url: "", prompt: "x" },
      { agent: agentStub },
    );
    expect("error" in r1 ? r1.error : "").toMatch(/url/);

    const r2 = await tool.execute(
      { url: "https://example.com", prompt: "" },
      { agent: agentStub },
    );
    expect("error" in r2 ? r2.error : "").toMatch(/prompt/);
  });

  it("rejects unsupported protocols", async () => {
    const tool = createWebFetchTool({
      model: new StubProvider(),
      fetchImpl: makeFetchImpl({}),
    });
    const r = await tool.execute(
      { url: "ftp://example.com/x", prompt: "anything" },
      { agent: agentStub },
    );
    expect("error" in r ? r.error : "").toMatch(/protocol/);
  });

  it("upgrades http:// to https:// transparently", async () => {
    const fetchImpl = makeFetchImpl({
      "https://example.com/page": () =>
        mockResponse({
          status: 200,
          headers: { "content-type": "text/html" },
          body: "<html><body><p>hi</p></body></html>",
        }),
    });
    const provider = new StubProvider("ok");
    const tool = createWebFetchTool({ model: provider, fetchImpl });

    const out = await tool.execute(
      { url: "http://example.com/page", prompt: "say ok" },
      { agent: agentStub },
    );
    expect("error" in out).toBe(false);
    if ("finalUrl" in out) {
      expect(out.url).toBe("http://example.com/page");
      expect(out.finalUrl).toBe("https://example.com/page");
      expect(out.content).toBe("ok");
    }
  });

  it("returns a structured redirect when the host changes", async () => {
    const fetchImpl = makeFetchImpl({
      "https://a.example.com/": () =>
        mockResponse({
          status: 302,
          headers: { location: "https://b.example.com/" },
        }),
    });
    const tool = createWebFetchTool({
      model: new StubProvider(),
      fetchImpl,
    });
    const out = await tool.execute(
      { url: "https://a.example.com/", prompt: "x" },
      { agent: agentStub },
    );
    expect("redirectTo" in out).toBe(true);
    if ("redirectTo" in out) {
      expect(out.redirectTo).toBe("https://b.example.com/");
      expect(out.redirectHost).toBe("b.example.com");
    }
  });

  it("follows same-host redirects transparently", async () => {
    const fetchImpl = makeFetchImpl({
      "https://example.com/old": () =>
        mockResponse({ status: 301, headers: { location: "/new" } }),
      "https://example.com/new": () =>
        mockResponse({
          status: 200,
          headers: { "content-type": "text/html" },
          body: "<html><body>fresh</body></html>",
        }),
    });
    const tool = createWebFetchTool({
      model: new StubProvider("fresh"),
      fetchImpl,
    });
    const out = await tool.execute(
      { url: "https://example.com/old", prompt: "find content" },
      { agent: agentStub },
    );
    expect("error" in out).toBe(false);
    if ("finalUrl" in out) {
      expect(out.finalUrl).toBe("https://example.com/new");
    }
  });

  it("propagates HTTP error status", async () => {
    const fetchImpl = makeFetchImpl({
      "https://example.com/missing": () =>
        mockResponse({ status: 404, statusText: "Not Found" }),
    });
    const tool = createWebFetchTool({
      model: new StubProvider(),
      fetchImpl,
    });
    const out = await tool.execute(
      { url: "https://example.com/missing", prompt: "x" },
      { agent: agentStub },
    );
    if ("error" in out) {
      expect(out.error).toMatch(/404/);
      expect(out.status).toBe(404);
    } else {
      throw new Error("expected error output");
    }
  });

  it("forwards the page markdown to the model and returns the answer", async () => {
    const fetchImpl = makeFetchImpl({
      "https://example.com/": () =>
        mockResponse({
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
          body: "<html><head><title>Greet</title></head><body><p>Hello world.</p></body></html>",
        }),
    });
    const provider = new StubProvider("Greeting page that says hello.");
    const tool = createWebFetchTool({ model: provider, fetchImpl });

    const out = await tool.execute(
      { url: "https://example.com/", prompt: "summarise" },
      { agent: agentStub },
    );

    expect("content" in out).toBe(true);
    if ("content" in out) {
      expect(out.content).toBe("Greeting page that says hello.");
    }
    expect(provider.received).toHaveLength(1);
    const userMsg = provider.received[0].messages.find((m) => m.role === "user");
    expect(typeof userMsg?.content).toBe("string");
    expect(userMsg?.content as string).toContain("# Greet");
    expect(userMsg?.content as string).toContain("Hello world");
    expect(userMsg?.content as string).toContain("summarise");
  });

  it("caches identical (url, prompt, model) tuples for 15 minutes", async () => {
    let hits = 0;
    const fetchImpl = makeFetchImpl({
      "https://example.com/cache": () => {
        hits++;
        return mockResponse({
          status: 200,
          headers: { "content-type": "text/html" },
          body: "<html><body>p</body></html>",
        });
      },
    });
    const tool = createWebFetchTool({
      model: new StubProvider("a"),
      fetchImpl,
    });

    const r1 = await tool.execute(
      { url: "https://example.com/cache", prompt: "p" },
      { agent: agentStub },
    );
    const r2 = await tool.execute(
      { url: "https://example.com/cache", prompt: "p" },
      { agent: agentStub },
    );

    expect(hits).toBe(1);
    if ("cached" in r1) expect(r1.cached).toBeUndefined();
    if ("cached" in r2) expect(r2.cached).toBe(true);
  });

  it("truncates over-long content before sending to the model", async () => {
    const longHtml = "<html><body>" + "x".repeat(200_000) + "</body></html>";
    const fetchImpl = makeFetchImpl({
      "https://example.com/big": () =>
        mockResponse({
          status: 200,
          headers: { "content-type": "text/html" },
          body: longHtml,
        }),
    });
    const provider = new StubProvider("ok");
    const tool = createWebFetchTool({
      model: provider,
      maxContentChars: 5000,
      fetchImpl,
    });

    const out = await tool.execute(
      { url: "https://example.com/big", prompt: "x" },
      { agent: agentStub },
    );

    if ("truncated" in out) {
      expect(out.truncated).toBe(true);
    } else {
      throw new Error("expected success output");
    }
    const userMsg = provider.received[0].messages.find((m) => m.role === "user");
    const text = userMsg?.content as string;
    // System + Prompt boilerplate shouldn't bring us anywhere near 200k chars.
    expect(text.length).toBeLessThan(7000);
  });

  it("pretty-prints JSON content type", async () => {
    const fetchImpl = makeFetchImpl({
      "https://example.com/api": () =>
        mockResponse({
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hello: "world" }),
        }),
    });
    const provider = new StubProvider("json ok");
    const tool = createWebFetchTool({ model: provider, fetchImpl });

    await tool.execute(
      { url: "https://example.com/api", prompt: "what's here" },
      { agent: agentStub },
    );

    const userMsg = provider.received[0].messages.find((m) => m.role === "user");
    expect(userMsg?.content as string).toContain('"hello": "world"');
  });

  it("returns an error structure when the model summarisation throws", async () => {
    const failingProvider: LLMProvider = {
      name: "boom",
      async chat() {
        throw new Error("upstream went down");
      },
      async *stream() {},
    };
    const fetchImpl = makeFetchImpl({
      "https://example.com/": () =>
        mockResponse({
          status: 200,
          headers: { "content-type": "text/html" },
          body: "<html></html>",
        }),
    });
    const tool = createWebFetchTool({ model: failingProvider, fetchImpl });

    const out = await tool.execute(
      { url: "https://example.com/", prompt: "x" },
      { agent: agentStub },
    );
    if ("error" in out) {
      expect(out.error).toMatch(/upstream/);
    } else {
      throw new Error("expected error output");
    }
  });
});
